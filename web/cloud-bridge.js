// Called by pre.js while native startup is held by restore-saves.
(function () {
  let root = '/persist', activePlayer = null, enabled = false;
  let sequence = 0;
  const pending = new Map();
  function rpc(action, data = {}) {
    if (parent === window) return Promise.resolve(null);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      // Conflict selection may wait for a person; API requests have their own timeout.
      pending.set(id, { resolve, reject });
      parent.postMessage({ source: 'stk-cloud', id, action, ...data }, location.origin);
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.source !== 'stk-cloud-response') return;
    const operation = pending.get(event.data.id);
    if (!operation) return;
    pending.delete(event.data.id);
    if (event.data.error) operation.reject(new Error(event.data.error));
    else operation.resolve(event.data.result);
  });
  const path = prefix => prefix + '/config/supertuxkart/config-0.10/players.xml';
  function read(fs, prefix) {
    try { return STKProgress.payload(fs.readFile(path(prefix), { encoding: 'utf8' })); }
    catch (error) {
      if (error.errno === 44 || error.code === 'ENOENT') return null;
      throw error;
    }
  }
  Module['restoreCloudProgress'] = async function (fs, env) {
    const bootstrap = await rpc('bootstrap');
    if (!bootstrap?.player) return;
    if (!/^[a-f0-9-]{36}$/.test(bootstrap.player.id)) throw new Error('Invalid platform player.');
    activePlayer = bootstrap.player.id;
    root = '/persist/accounts/' + activePlayer;
    env['XDG_CONFIG_HOME'] = root + '/config';
    env['XDG_DATA_HOME'] = root + '/data';
    fs.mkdirTree(env['XDG_CONFIG_HOME']);
    fs.mkdirTree(env['XDG_DATA_HOME']);
    Module['platformIdentity'] = Object.freeze({ id: activePlayer, displayName: bootstrap.player.displayName });
    Module['platformInventory'] = Object.freeze(bootstrap.items ?? []);
    let local = read(fs, root);
    if (!local && bootstrap.importGuest) local = read(fs, '/persist');
    const result = await rpc('restore', { playerId: activePlayer, local });
    enabled = !!result?.sync;
    const payload = result?.payload ? STKProgress.validate(result.payload) : local;
    if (payload) {
      fs.mkdirTree(root + '/config/supertuxkart/config-0.10');
      fs.writeFile(path(root), payload.playersXml);
      await new Promise((resolve, reject) => fs.syncfs(false, error => error ? reject(error) : resolve()));
    }
  };
  Module['uploadCloudProgress'] = async function (fs) {
    if (!activePlayer || !enabled) return;
    const payload = read(fs, root);
    if (payload) {
      const result = await rpc('save', { playerId: activePlayer, payload });
      if (result?.synced && typeof result.displayName === 'string')
        Module['platformIdentity'] = Object.freeze({ id: activePlayer, displayName: result.displayName });
    }
  };
})();
