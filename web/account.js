(function () {
  const panel = document.getElementById('account');
  const info = document.getElementById('account-status');
  const connect = document.getElementById('connect-wallet');
  const switchWallet = document.getElementById('switch-wallet');
  const logout = document.getElementById('sign-out');
  const dialog = document.getElementById('save-conflict');
  let player = null, config = null, busy = false, playing = false;
  let importGuest = false, sync = null, provider = null, signing = false;
  let generation = 0;
  const text = message => { info.textContent = message; };
  function render() {
    const registered = player?.kind === 'registered';
    logout.hidden = !registered;
    switchWallet.hidden = !registered;
    connect.textContent = registered ? 'Link another wallet' : 'Connect wallet';
    for (const button of panel.querySelectorAll('button, input')) button.disabled = busy || playing;
    panel.dataset.player = registered ? player.id : 'guest';
    window.dispatchEvent(new CustomEvent('stk-account-busy', { detail: { busy } }));
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/' + path, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(player?.kind === 'registered' ? { 'X-STK-Player': player.id } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error === 'save_conflict' ? 'Progress changed on another device.' : (data.error || 'Account service unavailable.'));
      error.status = response.status; error.data = data; throw error;
    }
    return data;
  }
  async function refresh() { player = (await api('session')).player; render(); }
  function attachProvider(next) {
    if (provider === next || !next?.request) return;
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
      provider?.removeListener?.(event, invalidateWallet);
      next.on?.(event, invalidateWallet);
    }
    provider = next;
  }
  function changed() {
    generation++; sync = null; render();
    window.dispatchEvent(new Event('stk-account-changed'));
  }
  const ready = (async () => {
    try {
      [config] = await Promise.all([api('config'), refresh()]);
      attachProvider(window.ethereum);
      text(player?.kind === 'registered' ? 'Wallet connected. Press Play to continue with your in-game player.' : 'Playing as a guest. Connect a wallet to save progress across devices.');
    } catch { text('Guest play is available. Cloud accounts are currently unavailable.'); }
    render();
  })();
  window.STKAccount = { ready, get busy() { return busy; } };
  function choose(current, local) {
    document.getElementById('cloud-save-detail').textContent = `Cloud revision ${current.revision}${current.updatedAt ? ', saved ' + new Date(current.updatedAt).toLocaleString() : ''}.`;
    dialog.showModal();
    return new Promise(resolve => {
      const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'local' ? local : dialog.returnValue === 'cloud' ? current.payload : null); };
      dialog.returnValue = 'offline';
      dialog.addEventListener('close', close);
    });
  }
  async function restore(local, mine) {
    sync = null;
    let cloud;
    try { cloud = await api('progress'); }
    catch { text('Cloud saves are unavailable. Progress will stay on this device.'); return { payload: local, sync: false }; }
    if (mine !== generation) throw new Error('Account changed. Reload before playing.');
    if (cloud.payload) cloud.payload = STKProgress.validate(cloud.payload);
    let selected = cloud.payload || local;
    if (cloud.payload && local && !STKProgress.same(cloud.payload, local)) {
      selected = await choose(cloud, local);
      if (!selected) { text('Playing locally; cloud sync is paused.'); return { payload: local, sync: false }; }
    }
    sync = { playerId: player.id, revision: cloud.revision, last: cloud.payload, blocked: false, generation: mine };
    text(`Cloud progress ready for ${player.displayName}.`);
    return { payload: selected, sync: true };
  }
  async function save(payload, mine) {
    const state = sync;
    if (!state || state.blocked || state.generation !== mine) return { synced: false };
    const selectedName = STKProgress.playerName(payload);
    if (STKProgress.same(payload, state.last) && (!selectedName || selectedName === player.displayName)) return { synced: true, displayName: player.displayName };
    try {
      const result = await api('progress', 'PUT', { baseRevision: state.revision, payload });
      if (mine !== generation || state !== sync) return { synced: false };
      state.revision = result.revision; state.last = result.payload;
      if (result.displayName) player.displayName = result.displayName;
      text(`Progress saved to cloud (revision ${result.revision}).`);
      return { synced: true, displayName: player.displayName };
    } catch (error) {
      if (error.status === 401 || error.data?.error === 'account_changed') {
        generation++; sync = null; player = null; render();
        text('Your sign-in changed or expired. Progress is safe on this device. Connect your wallet again after quitting.');
        if (!playing) window.dispatchEvent(new Event('stk-account-changed'));
      } else if (error.status === 409) {
        state.blocked = true;
        text('Progress changed on another device. Your local copy is safe. Choose which save to use before your next game.');
      } else text('Cloud save failed. Your progress is kept on this device; sync will retry.');
      return { synced: false };
    }
  }
  // Each iframe has a serial request queue; an old frame can never write into a new account.
  let queue = Promise.resolve();
  window.addEventListener('message', event => {
    const frame = document.getElementById('game');
    const data = event.data;
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin || data?.source !== 'stk-cloud' || !Number.isSafeInteger(data.id)) return;
    const mine = generation;
    queue = queue.catch(() => {}).then(async () => {
      if (event.source !== document.getElementById('game')?.contentWindow || mine !== generation) return;
      try {
        let result = null;
        if (data.action === 'bootstrap') {
          await ready;
          let items = [];
          if (player?.kind === 'registered') {
            try { items = (await api('inventory')).items.filter(item => typeof item.item_id === 'string' && /^[\w.-]{1,100}$/.test(item.item_id)); } catch { /* No entitlements are inferred from local saves. */ }
          }
          result = { player: player?.kind === 'registered' ? player : null, importGuest, items };
          importGuest = false;
        } else if (player?.kind === 'registered' && data.playerId === player.id) {
          if (data.action === 'restore') result = await restore(data.local ? STKProgress.validate(data.local) : null, mine);
          else if (data.action === 'save') result = await save(STKProgress.validate(data.payload), mine);
          else throw new Error('Unsupported game request.');
        } else throw new Error('Account no longer matches this game.');
        event.source.postMessage({ source: 'stk-cloud-response', id: data.id, result }, location.origin);
      } catch (error) { event.source.postMessage({ source: 'stk-cloud-response', id: data.id, error: error.message }, location.origin); }
    });
  });
  async function invalidateWallet() {
    if (signing) return;
    generation++; sync = null;
    try { await api('logout', 'POST'); } catch { /* Stop all local sync even if offline. */ }
    player = null; importGuest = false; render();
    text('Wallet account or network changed. Sign in again before syncing.');
    // Freeze the active account namespace until quit; do not switch a running game.
    if (!playing) window.dispatchEvent(new Event('stk-account-changed'));
  }
  const walletCode = error => error?.rpcCode ?? error?.data?.originalError?.code ?? error?.code;
  async function chooseWalletAccount(mode) {
    let pickerSupported = true;
    try { await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
    catch (error) {
      if (![4200, -32601].includes(walletCode(error))) throw error;
      pickerSupported = false;
    }
    const returned = await provider.request({ method: 'eth_requestAccounts' });
    const accounts = Array.isArray(returned) ? returned.filter((address, index) =>
      typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) &&
      returned.findIndex(other => typeof other === 'string' && other.toLowerCase() === address.toLowerCase()) === index) : [];
    if (!accounts.length) throw new Error('No account was shared by your wallet. Open your wallet and connect an account to this site.');
    if (accounts.length === 1 && pickerSupported && mode === 'login') return accounts[0];

    const chooser = document.getElementById('wallet-account-dialog');
    const form = document.getElementById('wallet-account-form');
    const cancel = document.getElementById('wallet-account-cancel');
    const list = document.getElementById('wallet-account-list');
    document.getElementById('wallet-account-title').textContent = mode === 'link' ? 'Link another wallet' : mode === 'switch' ? 'Switch player account' : 'Choose a wallet account';
    document.getElementById('wallet-account-description').textContent = mode === 'link'
      ? 'Add a wallet to your current player. Your progress stays with this player.'
      : mode === 'switch' ? 'Sign in to the player for the account you select. Your current player keeps their progress.'
      : 'Choose the wallet account you want to sign in with.';
    list.replaceChildren();
    for (const address of accounts) {
      const label = document.createElement('label'); label.className = 'wallet-option';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'wallet-account'; radio.value = address; radio.required = true;
      const caption = document.createElement('span');
      const linked = player?.wallets?.includes(address.toLowerCase());
      caption.textContent = address + (linked ? ' (linked to your current player)' : '');
      label.append(radio, caption); list.appendChild(label);
    }
    chooser.returnValue = 'cancel';
    return new Promise(resolve => {
      const submit = event => {
        event.preventDefault();
        if (form.querySelector('input[name="wallet-account"]:checked')) chooser.close('confirm');
      };
      const dismiss = () => chooser.close('cancel');
      const close = () => {
        const address = form.querySelector('input[name="wallet-account"]:checked')?.value;
        form.removeEventListener('submit', submit); cancel.removeEventListener('click', dismiss); chooser.removeEventListener('close', close);
        resolve(chooser.returnValue === 'confirm' ? address : null);
      };
      form.addEventListener('submit', submit); cancel.addEventListener('click', dismiss); chooser.addEventListener('close', close);
      chooser.showModal();
    });
  }
  async function connectAccount(mode) {
    if (busy || playing) return;
    busy = true; signing = true; render();
    const wasGuest = player?.kind !== 'registered';
    const previousPlayer = player?.id;
    let verified = false;
    try {
      config ??= await api('config');
      const next = window.ethereum;
      if (!next?.request) throw new Error('Install an injected desktop Ethereum wallet to connect.');
      attachProvider(next);
      const address = await chooseWalletAccount(mode);
      if (!address) throw Object.assign(new Error('Account selection cancelled.'), { code: 4001 });
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('No wallet account selected.');
      if (mode === 'link' && player?.wallets?.includes(address.toLowerCase())) throw new Error('That account is already linked to your player. Choose a different wallet account to link.');
      const chain = await provider.request({ method: 'eth_chainId' });
      if (chain.toLowerCase() !== config.chain.chainId) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chain.chainId }] }); }
        catch (error) {
          if (error.code !== 4902) throw error;
          await provider.request({ method: 'wallet_addEthereumChain', params: [config.chain] });
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chain.chainId }] });
        }
      }
      if (wasGuest && mode === 'login') await api('guest', 'POST');
      const challenge = await api('auth/challenge', 'POST', { address, chainId: config.chainId, purpose: mode });
      const message = '0x' + Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('');
      const signature = await provider.request({ method: 'personal_sign', params: [message, address] });
      const selected = await provider.request({ method: 'eth_accounts' });
      const selectedChain = await provider.request({ method: 'eth_chainId' });
      if (!Array.isArray(selected) || !selected.some(value => typeof value === 'string' && value.toLowerCase() === address.toLowerCase()) || selectedChain.toLowerCase() !== config.chain.chainId) throw new Error('Wallet changed while signing. Please try again.');
      await api('auth/verify', 'POST', { id: challenge.id, signature });
      verified = true;
      await refresh(); importGuest = wasGuest && mode === 'login'; changed();
      text(mode === 'link' ? 'Wallet linked. You are still using the same player and progress.'
        : mode === 'switch' && player.id === previousPlayer ? 'This wallet uses your current player profile. Your progress is unchanged.'
        : mode === 'switch' ? 'Account switched. Press Play to continue with this player.'
        : 'Wallet connected. Press Play to choose or continue your player profile.');
    } catch (error) {
      if (verified) { player = null; importGuest = false; changed(); text('Wallet sign-in succeeded, but the player could not be loaded. Reload to continue.'); }
      else if (walletCode(error) === 4001) text(wasGuest ? 'Wallet request cancelled. Guest play remains available.' : 'Wallet request cancelled. Your current player is unchanged.');
      else if (walletCode(error) === -32002) text('A wallet request is already pending. Open your wallet to finish or cancel it.');
      else if (error.data?.error === 'wallet_belongs_to_another_player') text('That wallet belongs to another player. Use Switch account to sign in to that player.');
      else if (error.data?.error === 'account_changed') text('Your sign-in changed in another tab. Reload before connecting a wallet.');
      else if (error.data?.error === 'challenge_expired_or_used') text('The wallet request expired. Choose your account and sign in again.');
      else if (error.data?.error === 'invalid_signature') text('The signature could not be verified. Try signing with the account you selected.');
      else if (error.status === 401 || error.data?.error === 'sign_in_first') text('Your sign-in expired. Reload the page, then connect your wallet again.');
      else text(error.message);
    }
    finally { signing = false; busy = false; render(); }
  }
  connect.addEventListener('click', () => connectAccount(player?.kind === 'registered' ? 'link' : 'login'));
  switchWallet.addEventListener('click', () => connectAccount('switch'));
  logout.addEventListener('click', async () => {
    if (busy || playing) return;
    busy = true; render();
    try { await api('logout', 'POST'); player = null; importGuest = false; changed(); text('Signed out. Guest progress stays on this device.'); }
    catch { text('Could not sign out. Check your connection and try again.'); }
    finally { busy = false; render(); }
  });
  window.addEventListener('stk-session-state', event => { playing = event.detail.running; render(); });
})();
