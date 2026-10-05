// 実機での演出のなめらかさ確認用（?perf=1 のときだけ有効。フラグが無ければ何も作らない）。
// 抽選の入力直後（空転の開始）〜結果カードが出る瞬間まで、rAF の間隔を記録して右上に1行で表示する：
//   「frames: N, >33ms: K, max: X ms」（>33ms = 2フレーム以上の落ち）。直近3回分を残す。
// 計測中は表示を更新しない（計測自体が描画の邪魔をしないように）。

export function createPerf() {
  let on = false;
  try { on = new URLSearchParams(location.search).get('perf') === '1'; } catch { /* noop */ }
  if (!on) return null;

  const el = document.createElement('pre');
  el.setAttribute('data-testid', 'perf-overlay');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;top:6px;right:6px;margin:0;padding:4px 8px;z-index:2147483000;pointer-events:none;'
    + 'font:500 11px/1.4 ui-monospace,Menlo,monospace;color:#fff;background:rgba(10,14,51,.82);border-radius:3px;'
    + 'white-space:pre;text-align:right;-webkit-user-select:none;user-select:none;';
  el.textContent = 'perf: ready';
  document.body.appendChild(el);

  const history = [];
  let ts = []; let raf = 0; let label = ''; let t0 = 0;
  const loop = (t) => { ts.push(t); raf = requestAnimationFrame(loop); };

  const summarize = () => {
    const d = [];
    for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
    let max = 0; let at = 0; let slow = 0;
    d.forEach((x, i) => { if (x > 33) slow++; if (x > max) { max = x; at = ts[i + 1] - t0; } });
    return { n: d.length, slow, max, at };
  };

  return {
    start(name = 'draw') {
      cancelAnimationFrame(raf);
      label = name; ts = []; t0 = performance.now();
      el.textContent = [...history, `${label}: measuring…`].join('\n');
      raf = requestAnimationFrame(loop);
    },
    stop(name) {
      if (!raf) return;
      cancelAnimationFrame(raf); raf = 0;
      const r = summarize();
      history.push(`${name || label}  frames: ${r.n}, >33ms: ${r.slow}, max: ${Math.round(r.max)} ms (@${(r.at / 1000).toFixed(1)}s)`);
      while (history.length > 3) history.shift();
      el.textContent = history.join('\n');
      ts = [];
    },
    cancel() {
      cancelAnimationFrame(raf); raf = 0; ts = [];
      el.textContent = history.length ? history.join('\n') : 'perf: ready';
    },
  };
}
