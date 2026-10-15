// Shared fixture helper. Every page records observable outcomes in window.__fx so
// e2e tests can assert results (via `evaluate`, world 'page') without trusting the agent.
(function () {
  const fx = (window.__fx = window.__fx || { events: [], state: {} });
  fx.log = function (type, data) {
    const entry = { type, data: data === undefined ? null : data, t: Math.round(performance.now()) };
    fx.events.push(entry);
    const el = document.getElementById("fx-log");
    if (el) {
      const li = document.createElement("li");
      li.textContent = type + (data === undefined ? "" : " " + JSON.stringify(data));
      el.appendChild(li);
    }
    return entry;
  };
  fx.last = function (type) {
    for (let i = fx.events.length - 1; i >= 0; i--) if (!type || fx.events[i].type === type) return fx.events[i];
    return null;
  };
  fx.count = function (type) { return fx.events.filter((e) => e.type === type).length; };
  fx.config = window.__FX_CONFIG || { origin: location.origin, crossOrigin: location.origin };
})();
