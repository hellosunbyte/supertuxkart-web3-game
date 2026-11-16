(function () {
  const panel = document.getElementById('account');
  const info = document.getElementById('account-status');
  const connect = document.getElementById('connect-wallet');
  const logout = document.getElementById('sign-out');
  const profile = document.getElementById('profile-form');
  const name = document.getElementById('display-name');
  const saveProfile = document.getElementById('save-profile');
  const profileFeedback = document.getElementById('profile-feedback');
  const dialog = document.getElementById('save-conflict');
  let player = null, config = null, busy = false, playing = false;
  let importGuest = false, sync = null, provider = null, signing = false;
  let generation = 0;
  let editingPlayerId = null, profileState = 'idle';
  const text = message => { info.textContent = message; };
  function profileMessage(message, state) {
    profileState = state;
    profileFeedback.textContent = message;
    profileFeedback.dataset.state = state;
    profileFeedback.hidden = !message;
  }
  function render() {
    const registered = player?.kind === 'registered';
    profile.hidden = !registered;
    logout.hidden = !registered;
    connect.textContent = registered ? 'Link another wallet' : 'Connect wallet';
    // Refresh the input only when switching players. Other UI updates must not
    // discard an edit or a failed save's draft.
    if (registered && editingPlayerId !== player.id) {
      editingPlayerId = player.id;
      name.value = player.displayName;
      profileMessage('', 'idle');
    } else if (!registered) {
      editingPlayerId = null;
      profileMessage('', 'idle');
    }
    for (const button of panel.querySelectorAll('button, input')) button.disabled = busy || playing;
    const dirty = registered && name.value.trim() !== player.displayName;
    saveProfile.textContent = profileState === 'saving' ? 'Saving…' : profileState === 'success' ? 'Saved' : profileState === 'error' ? 'Try again' : 'Save profile';
    saveProfile.dataset.state = profileState;
    saveProfile.disabled = busy || playing || !dirty;
    profile.setAttribute('aria-busy', String(profileState === 'saving'));
    panel.dataset.player = registered ? player.id : 'guest';
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
      text(player?.kind === 'registered' ? `Signed in as ${player.displayName}.` : 'Playing as a guest. Connect a wallet to save progress across devices.');
    } catch { text('Guest play is available. Cloud accounts are currently unavailable.'); }
    render();
  })();
  window.STKAccount = { ready };
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
    if (STKProgress.same(payload, state.last)) return { synced: true };
    try {
      const result = await api('progress', 'PUT', { baseRevision: state.revision, payload });
      if (mine !== generation || state !== sync) return { synced: false };
      state.revision = result.revision; state.last = result.payload;
      text(`Progress saved to cloud (revision ${result.revision}).`);
      return { synced: true };
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
  connect.addEventListener('click', async () => {
    if (busy || playing) return;
    busy = true; signing = true; render();
    const wasGuest = player?.kind !== 'registered';
    try {
      config ??= await api('config');
      const next = window.ethereum;
      if (!next?.request) throw new Error('Install an injected desktop Ethereum wallet to connect.');
      attachProvider(next);
      if (!wasGuest) await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const address = accounts?.[0];
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('No wallet account selected.');
      const chain = await provider.request({ method: 'eth_chainId' });
      if (chain.toLowerCase() !== config.chain.chainId) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chain.chainId }] }); }
        catch (error) {
          if (error.code !== 4902) throw error;
          await provider.request({ method: 'wallet_addEthereumChain', params: [config.chain] });
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chain.chainId }] });
        }
      }
      await api('guest', 'POST');
      const challenge = await api('auth/challenge', 'POST', { address, chainId: config.chainId, purpose: wasGuest ? 'login' : 'link' });
      const message = '0x' + Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('');
      const signature = await provider.request({ method: 'personal_sign', params: [message, address] });
      const selected = await provider.request({ method: 'eth_accounts' });
      const selectedChain = await provider.request({ method: 'eth_chainId' });
      if (selected?.[0]?.toLowerCase() !== address.toLowerCase() || selectedChain.toLowerCase() !== config.chain.chainId) throw new Error('Wallet changed while signing. Please try again.');
      await api('auth/verify', 'POST', { id: challenge.id, signature });
      await refresh(); importGuest = wasGuest; changed();
      text(`Signed in as ${player.displayName}.`);
    } catch (error) { text(error.code === 4001 ? 'Wallet request cancelled. Guest play remains available.' : error.message); }
    finally { signing = false; busy = false; render(); }
  });
  logout.addEventListener('click', async () => {
    if (busy || playing) return;
    busy = true; render();
    try { await api('logout', 'POST'); player = null; importGuest = false; changed(); text('Signed out. Guest progress stays on this device.'); }
    catch { text('Could not sign out. Check your connection and try again.'); }
    finally { busy = false; render(); }
  });
  profile.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || playing) return;
    const displayName = name.value.trim();
    if (!displayName) {
      profileMessage('Enter a player name before saving.', 'error');
      render(); name.focus(); return;
    }
    if (displayName === player?.displayName) return;
    busy = true; profileMessage('Saving your profile…', 'saving'); render();
    try {
      const updated = await api('profile', 'PATCH', { displayName });
      player.displayName = updated.displayName;
      name.value = updated.displayName;
      profileMessage(`Profile saved as “${updated.displayName}”.`, 'success');
      text(`Signed in as ${updated.displayName}.`);
    } catch (error) {
      const message = error.data?.error === 'invalid_input' ? 'Use 1–40 characters for your player name.'
        : error.status === 401 || error.status === 403 ? 'Your sign-in expired. Sign in again, then save your profile.'
        : error.data?.error === 'account_changed' ? 'Your account changed in another tab. Reload before saving.'
        : 'Could not save your profile. Your changes are still here. Please try again.';
      profileMessage(message, 'error');
    }
    finally { busy = false; render(); }
  });
  name.addEventListener('input', () => {
    const dirty = player?.kind === 'registered' && name.value.trim() !== player.displayName;
    profileMessage(dirty ? 'You have unsaved changes.' : '', 'idle');
    render();
  });
  window.addEventListener('stk-session-state', event => { playing = event.detail.running; render(); });
})();
