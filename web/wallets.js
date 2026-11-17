// Wallet discovery never requests account access. Only the explicitly selected
// provider may receive permission, account, network or signing requests.
(function () {
  const entries = new Map();
  const uuids = new Map();
  let sequence = 0, repaint = null, walletChoicePending = false, accountChoicePending = false;
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const code = error => error?.rpcCode ?? error?.data?.originalError?.code ?? error?.code;
  function phantom(provider) {
    return provider?.isPhantom === true || provider === window.phantom?.ethereum;
  }
  function vendor(provider) {
    return !provider ? null : phantom(provider) ? 'phantom' : provider.isMetaMask === true ? 'metamask' : null;
  }
  function add(provider, info = {}, announced = false) {
    if (!provider || typeof provider.request !== 'function') return;
    if (announced) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(info.uuid) ||
          typeof info.name !== 'string' || !info.name.trim() || typeof info.rdns !== 'string') return;
      if (uuids.has(info.uuid) && uuids.get(info.uuid) !== provider) return;
      uuids.set(info.uuid, provider);
    }
    // A vendor may expose a different proxy under its legacy namespace. Prefer
    // the announced provider without listing the same extension twice.
    const kind = vendor(provider);
    if (kind) {
      if (!announced && Array.from(entries.values()).some(entry => entry.announced && vendor(entry.provider) === kind)) return;
      if (announced) for (const [candidate, entry] of entries)
        if (candidate !== provider && !entry.announced && vendor(candidate) === kind) entries.delete(candidate);
    }
    const old = entries.get(provider);
    // Phantom may also expose isMetaMask for compatibility. Check Phantom first.
    const isPhantom = phantom(provider);
    const name = isPhantom ? 'Phantom' : announced ? info.name.trim().slice(0, 80)
      : old?.announced ? old.name : provider.isMetaMask === true ? 'MetaMask' : 'Browser wallet';
    if (old && old.name === name && (!announced || old.announced)) return;
    entries.set(provider, { id: old?.id ?? 'wallet-' + ++sequence, provider, name,
      rdns: announced ? info.rdns : old?.rdns ?? '', announced: announced || !!old?.announced });
    repaint?.();
  }
  function legacy() {
    const root = window.ethereum;
    add(window.phantom?.ethereum);
    if (Array.isArray(root?.providers)) {
      for (const provider of root.providers) add(provider);
    } else if (root && (entries.size === 0 || phantom(root) || root.isMetaMask === true)) {
      // Do not add an ambiguous global proxy alongside discovered providers.
      add(root);
    }
  }
  function discover() {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    legacy();
    return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
  window.addEventListener('eip6963:announceProvider', event => {
    const detail = event.detail;
    if (detail && typeof detail === 'object') add(detail.provider, detail.info ?? {}, true);
  });
  discover();

  function select() {
    if (walletChoicePending) return Promise.reject(new Error('Finish choosing your wallet first.'));
    const dialog = document.getElementById('wallet-picker');
    const list = document.getElementById('wallet-list');
    const empty = document.getElementById('wallet-empty');
    const refresh = document.getElementById('wallet-refresh');
    const cancel = document.getElementById('wallet-cancel');
    walletChoicePending = true;
    let selected = null;
    return new Promise((resolve, reject) => {
      const render = () => {
        list.replaceChildren();
        const wallets = Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
        empty.hidden = wallets.length > 0;
        for (const wallet of wallets) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'wallet-option';
          button.dataset.walletId = wallet.id;
          const name = document.createElement('strong'); name.textContent = wallet.name;
          const description = document.createElement('span');
          description.textContent = 'Choose this wallet';
          button.append(name, description);
          button.addEventListener('click', () => { selected = wallet; dialog.close('selected'); });
          list.appendChild(button);
        }
      };
      const rescan = () => { discover(); render(); };
      const dismiss = () => dialog.close('cancel');
      const cleanup = () => {
        repaint = null; walletChoicePending = false;
        refresh.removeEventListener('click', rescan); cancel.removeEventListener('click', dismiss); dialog.removeEventListener('close', close);
      };
      const close = () => { cleanup(); resolve(dialog.returnValue === 'selected' ? selected : null); };
      refresh.addEventListener('click', rescan); cancel.addEventListener('click', dismiss); dialog.addEventListener('close', close);
      repaint = render;
      dialog.returnValue = 'cancel'; rescan();
      try { dialog.showModal(); } catch (error) { cleanup(); reject(error); }
    });
  }
  async function chooseAccount(wallet) {
    if (accountChoicePending) throw new Error('Finish choosing your account first.');
    if (!wallet || typeof wallet.provider?.request !== 'function') throw new Error('Choose an Ethereum-compatible wallet.');
    accountChoicePending = true;
    try { return await requestAccount(wallet); }
    finally { accountChoicePending = false; }
  }
  async function requestAccount(wallet) {
    const selectedProvider = wallet.provider;
    // Request selection again even when this wallet already authorized the site.
    try { await selectedProvider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
    catch (error) { if (![4200, -32601].includes(code(error))) throw error; }
    const returned = await selectedProvider.request({ method: 'eth_requestAccounts' });
    const seen = new Set();
    const accounts = Array.isArray(returned) ? returned.filter(address => {
      if (typeof address !== 'string' || !addressPattern.test(address) || seen.has(address.toLowerCase())) return false;
      seen.add(address.toLowerCase()); return true;
    }) : [];
    if (!accounts.length) throw new Error('No Ethereum account was shared by this wallet. Open the wallet and connect an account to this site.');

    const dialog = document.getElementById('wallet-account-picker');
    const form = document.getElementById('wallet-account-form');
    const list = document.getElementById('wallet-account-list');
    const cancel = document.getElementById('wallet-account-cancel');
    document.getElementById('wallet-account-title').textContent = 'Choose an account in ' + wallet.name;
    list.replaceChildren();
    for (const address of accounts) {
      const label = document.createElement('label'); label.className = 'wallet-account-option';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'wallet-account'; radio.value = address; radio.required = true;
      radio.checked = accounts.length === 1;
      const caption = document.createElement('span'); caption.textContent = address;
      label.append(radio, caption); list.appendChild(label);
    }
    return await new Promise((resolve, reject) => {
      const submit = event => { event.preventDefault(); if (form.querySelector('input:checked')) dialog.close('selected'); };
      const dismiss = () => dialog.close('cancel');
      const cleanup = () => {
        form.removeEventListener('submit', submit); cancel.removeEventListener('click', dismiss); dialog.removeEventListener('close', close);
      };
      const close = () => {
        const address = form.querySelector('input:checked')?.value;
        cleanup(); resolve(dialog.returnValue === 'selected' ? address : null);
      };
      dialog.returnValue = 'cancel';
      form.addEventListener('submit', submit); cancel.addEventListener('click', dismiss); dialog.addEventListener('close', close);
      try { dialog.showModal(); } catch (error) { cleanup(); reject(error); }
    });
  }
  function isNetwork(actual, expected) {
    try { return typeof actual === 'string' && /^0x[0-9a-f]+$/i.test(actual) && BigInt(actual) === BigInt(expected); }
    catch { return false; }
  }
  async function ensureNetwork(wallet, chain) {
    const selectedProvider = wallet.provider;
    try {
      if (isNetwork(await selectedProvider.request({ method: 'eth_chainId' }), chain.chainId)) return;
      try { await selectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] }); }
      catch (error) {
        if (code(error) !== 4902) throw error;
        await selectedProvider.request({ method: 'wallet_addEthereumChain', params: [chain] });
        await selectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] });
      }
      if (!isNetwork(await selectedProvider.request({ method: 'eth_chainId' }), chain.chainId)) throw new Error('Network did not change.');
    } catch (error) {
      // Rejection and pending requests retain their meaning for every provider.
      if ([4001, -32002].includes(code(error))) throw error;
      throw Object.assign(new Error('This wallet could not connect to ' + chain.chainName + '. Enable this network in the wallet or choose another wallet.'), { code: 'wallet_network_unavailable' });
    }
  }
  window.STKWallets = { discover, select, chooseAccount, ensureNetwork, isNetwork, errorCode: code };
})();
