// Web Worker entry: runs the Hub off the main thread. Worker timers aren't throttled
// when the host's tab is in the background, so the battle keeps its 30 Hz pace.
//
//   main -> worker: {k:'init', code} {k:'open', id} {k:'msg', id, data} {k:'close', id} {k:'shutdown'}
//   worker -> main: {k:'send', id, data} {k:'close', id, reason}

import { Hub } from './hub.js';

let hub = null;

const transport = {
  send(id, data) { self.postMessage({ k: 'send', id, data }); },
  close(id, reason) { self.postMessage({ k: 'close', id, reason }); },
};

self.onmessage = (e) => {
  const m = e.data;
  switch (m.k) {
    case 'init': hub = new Hub(m.code, transport); break;
    case 'open': hub?.open(m.id); break;
    case 'msg': hub?.message(m.id, m.data); break;
    case 'close': hub?.closed(m.id); break;
    case 'shutdown': hub?.shutdown(m.msg); hub = null; break;
    default:
  }
};
