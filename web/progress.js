// Shared by the launcher and game frame. Only player progress crosses this boundary.
(function () {
  function sanitize(playersXml) {
    if (typeof playersXml !== 'string' || playersXml.length > 1000000 || /<!/.test(playersXml)) throw new Error('Unsupported player save.');
    const xml = new DOMParser().parseFromString(playersXml, 'application/xml');
    if (xml.querySelector('parsererror') || xml.documentElement?.tagName !== 'players') throw new Error('Invalid player save.');
    for (const player of xml.querySelectorAll('player')) {
      for (const [key, value] of Object.entries({ 'saved-token': '', 'saved-user': '0', 'saved-session': 'false', 'remember-password': 'false', 'last-was-online': 'false' })) player.setAttribute(key, value);
    }
    return new XMLSerializer().serializeToString(xml);
  }
  window.STKProgress = {
    sanitize,
    payload(playersXml) { return { schemaVersion: 1, playersXml: sanitize(playersXml) }; },
    validate(value) {
      if (!value || value.schemaVersion !== 1 || Object.keys(value).some(k => !['schemaVersion', 'playersXml'].includes(k))) throw new Error('Unsupported cloud save.');
      return { schemaVersion: 1, playersXml: sanitize(value.playersXml) };
    },
    same(a, b) { return (a?.playersXml ?? null) === (b?.playersXml ?? null); },
  };
})();
