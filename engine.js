/* Chess engine: aturan lengkap (rokade, en passant, promosi, skak mat, remis)
 * + bot dengan 3 tingkat kesulitan. Bisa jalan di main thread atau sebagai Web Worker. */
(function (root) {
  'use strict';

  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const MATE = 100000;

  const isW = p => p === p.toUpperCase();
  const colorOf = p => (p ? (isW(p) ? 'w' : 'b') : null);
  const sqName = s => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
  const sqIdx = n => (n.charCodeAt(0) - 97) + (n.charCodeAt(1) - 49) * 8;

  // ---------- tabel langkah (dihitung sekali) ----------
  const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const inB = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const KNT = [], KGT = [], RAYD = [], RAYO = [];
  for (let s = 0; s < 64; s++) {
    const f = s & 7, r = s >> 3;
    KNT[s] = KN.filter(([a, b]) => inB(f + a, r + b)).map(([a, b]) => (r + b) * 8 + f + a);
    KGT[s] = KG.filter(([a, b]) => inB(f + a, r + b)).map(([a, b]) => (r + b) * 8 + f + a);
    const ray = ([a, b]) => {
      const out = [];
      for (let x = f + a, y = r + b; inB(x, y); x += a, y += b) out.push(y * 8 + x);
      return out;
    };
    RAYD[s] = DIAG.map(ray);
    RAYO[s] = ORTH.map(ray);
  }
  // hak rokade yang tetap tersisa jika petak ini tersentuh (1=K 2=Q 4=k 8=q)
  const CR = new Array(64).fill(15);
  CR[0] = 13; CR[7] = 14; CR[4] = 12; CR[56] = 7; CR[63] = 11; CR[60] = 3;

  class Chess {
    constructor(fen) { this.load(fen || START); }

    load(fen) {
      const [pos, turn, cas, ep, half, full] = fen.trim().split(/\s+/);
      this.board = new Array(64).fill(null);
      const rows = pos.split('/');
      for (let i = 0; i < 8; i++) {
        let f = 0;
        for (const ch of rows[i]) {
          if (/\d/.test(ch)) f += +ch;
          else { this.board[(7 - i) * 8 + f] = ch; f++; }
        }
      }
      this.turn = turn || 'w';
      this.castle = !cas || cas === '-' ? 0 :
        (cas.includes('K') ? 1 : 0) | (cas.includes('Q') ? 2 : 0) | (cas.includes('k') ? 4 : 0) | (cas.includes('q') ? 8 : 0);
      this.ep = ep && ep !== '-' ? sqIdx(ep) : -1;
      this.half = +half || 0;
      this.full = +full || 1;
      this.kings = { w: this.board.indexOf('K'), b: this.board.indexOf('k') };
      this.stack = [];
      this.hist = [];
      this.track = true;
      this.keys = [this.key()];
    }

    fen() {
      let s = '';
      for (let r = 7; r >= 0; r--) {
        let e = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[r * 8 + f];
          if (!p) { e++; continue; }
          if (e) { s += e; e = 0; }
          s += p;
        }
        if (e) s += e;
        if (r) s += '/';
      }
      const c = (this.castle & 1 ? 'K' : '') + (this.castle & 2 ? 'Q' : '') + (this.castle & 4 ? 'k' : '') + (this.castle & 8 ? 'q' : '');
      return `${s} ${this.turn} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.half} ${this.full}`;
    }

    key() { return this.board.map(p => p || '.').join('') + this.turn + this.castle + this.ep; }

    attacked(s, by) {
      const b = this.board, w = by === 'w';
      const f = s & 7, r = s >> 3;
      const pr = w ? r - 1 : r + 1, P = w ? 'P' : 'p';
      if (pr >= 0 && pr < 8) {
        if (f > 0 && b[pr * 8 + f - 1] === P) return true;
        if (f < 7 && b[pr * 8 + f + 1] === P) return true;
      }
      const N = w ? 'N' : 'n', K = w ? 'K' : 'k', B = w ? 'B' : 'b', R = w ? 'R' : 'r', Q = w ? 'Q' : 'q';
      for (const t of KNT[s]) if (b[t] === N) return true;
      for (const t of KGT[s]) if (b[t] === K) return true;
      for (const ray of RAYD[s]) for (const t of ray) { const p = b[t]; if (p) { if (p === B || p === Q) return true; break; } }
      for (const ray of RAYO[s]) for (const t of ray) { const p = b[t]; if (p) { if (p === R || p === Q) return true; break; } }
      return false;
    }

    inCheck(c = this.turn) { return this.attacked(this.kings[c], c === 'w' ? 'b' : 'w'); }

    pseudo(capOnly) {
      const b = this.board, w = this.turn === 'w', out = [];
      const enemy = p => p && isW(p) !== w;
      for (let s = 0; s < 64; s++) {
        const p = b[s];
        if (!p || isW(p) !== w) continue;
        const t = p.toLowerCase();
        if (t === 'p') {
          const dir = w ? 8 : -8, r = s >> 3, f = s & 7, promoRank = r === (w ? 6 : 1);
          const one = s + dir;
          if (!b[one] && (!capOnly || promoRank)) {
            this.addPawn(out, s, one, p, null, promoRank, w);
            if (!capOnly && r === (w ? 1 : 6) && !b[one + dir]) out.push({ from: s, to: one + dir, p, cap: null, flag: 'd' });
          }
          for (const df of [-1, 1]) {
            if (f + df < 0 || f + df > 7) continue;
            const to = one + df;
            if (enemy(b[to])) this.addPawn(out, s, to, p, b[to], promoRank, w);
            else if (to === this.ep) out.push({ from: s, to, p, cap: w ? 'p' : 'P', flag: 'ep' });
          }
        } else if (t === 'n' || t === 'k') {
          for (const to of (t === 'n' ? KNT : KGT)[s]) {
            const q = b[to];
            if (q ? enemy(q) : !capOnly) out.push({ from: s, to, p, cap: q || null });
          }
          if (t === 'k' && !capOnly) this.addCastles(out, s, w);
        } else {
          const rays = t === 'b' ? RAYD[s] : t === 'r' ? RAYO[s] : RAYD[s].concat(RAYO[s]);
          for (const ray of rays) {
            for (const to of ray) {
              const q = b[to];
              if (!q) { if (!capOnly) out.push({ from: s, to, p, cap: null }); continue; }
              if (enemy(q)) out.push({ from: s, to, p, cap: q });
              break;
            }
          }
        }
      }
      return out;
    }

    addPawn(out, from, to, p, cap, promo, w) {
      if (!promo) { out.push({ from, to, p, cap }); return; }
      for (const x of 'qrbn') out.push({ from, to, p, cap, promo: w ? x.toUpperCase() : x });
    }

    addCastles(out, s, w) {
      const b = this.board, opp = w ? 'b' : 'w';
      if (w && s === 4) {
        if ((this.castle & 1) && !b[5] && !b[6] && b[7] === 'R' && !this.attacked(4, opp) && !this.attacked(5, opp) && !this.attacked(6, opp))
          out.push({ from: 4, to: 6, p: 'K', cap: null, flag: 'k' });
        if ((this.castle & 2) && !b[1] && !b[2] && !b[3] && b[0] === 'R' && !this.attacked(4, opp) && !this.attacked(3, opp) && !this.attacked(2, opp))
          out.push({ from: 4, to: 2, p: 'K', cap: null, flag: 'q' });
      } else if (!w && s === 60) {
        if ((this.castle & 4) && !b[61] && !b[62] && b[63] === 'r' && !this.attacked(60, opp) && !this.attacked(61, opp) && !this.attacked(62, opp))
          out.push({ from: 60, to: 62, p: 'k', cap: null, flag: 'k' });
        if ((this.castle & 8) && !b[57] && !b[58] && !b[59] && b[56] === 'r' && !this.attacked(60, opp) && !this.attacked(59, opp) && !this.attacked(58, opp))
          out.push({ from: 60, to: 58, p: 'k', cap: null, flag: 'q' });
      }
    }

    make(m) {
      const b = this.board, w = this.turn === 'w';
      this.stack.push({ m, castle: this.castle, ep: this.ep, half: this.half, kw: this.kings.w, kb: this.kings.b });
      b[m.to] = m.promo || m.p;
      b[m.from] = null;
      if (m.flag === 'ep') b[m.to + (w ? -8 : 8)] = null;
      else if (m.flag === 'k') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = null; }
      else if (m.flag === 'q') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = null; }
      if (m.p === 'K') this.kings.w = m.to; else if (m.p === 'k') this.kings.b = m.to;
      this.castle &= CR[m.from] & CR[m.to];
      this.ep = m.flag === 'd' ? (m.from + m.to) >> 1 : -1;
      this.half = (m.p === 'P' || m.p === 'p' || m.cap) ? 0 : this.half + 1;
      if (!w) this.full++;
      this.turn = w ? 'b' : 'w';
      if (this.track) this.keys.push(this.key());
    }

    undo() {
      const u = this.stack.pop();
      if (!u) return null;
      const m = u.m, b = this.board;
      this.turn = this.turn === 'w' ? 'b' : 'w';
      const w = this.turn === 'w';
      if (!w) this.full--;
      b[m.from] = m.p;
      if (m.flag === 'ep') { b[m.to] = null; b[m.to + (w ? -8 : 8)] = m.cap; }
      else b[m.to] = m.cap;
      if (m.flag === 'k') { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = null; }
      else if (m.flag === 'q') { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = null; }
      this.castle = u.castle; this.ep = u.ep; this.half = u.half;
      this.kings.w = u.kw; this.kings.b = u.kb;
      if (this.track) this.keys.pop();
      return m;
    }

    moves(capOnly) {
      const us = this.turn, out = [];
      const track = this.track;
      this.track = false;
      for (const m of this.pseudo(capOnly)) {
        this.make(m);
        if (!this.attacked(this.kings[us], this.turn)) out.push(m);
        this.undo();
      }
      this.track = track;
      return out;
    }

    insufficient() {
      const ps = [];
      for (let s = 0; s < 64; s++) {
        const p = this.board[s];
        if (p && p.toLowerCase() !== 'k') ps.push({ t: p.toLowerCase(), c: ((s & 7) + (s >> 3)) & 1 });
      }
      if (!ps.length) return true;
      if (ps.length === 1 && (ps[0].t === 'n' || ps[0].t === 'b')) return true;
      if (ps.every(x => x.t === 'b') && ps.every(x => x.c === ps[0].c)) return true;
      return false;
    }

    status() {
      const legal = this.moves();
      const check = this.inCheck();
      if (!legal.length) {
        return check ? { over: true, result: this.turn === 'w' ? 'b' : 'w', reason: 'checkmate', legal, check }
          : { over: true, result: 'd', reason: 'stalemate', legal, check };
      }
      if (this.half >= 100) return { over: true, result: 'd', reason: 'fifty', legal, check };
      if (this.insufficient()) return { over: true, result: 'd', reason: 'material', legal, check };
      const k = this.keys[this.keys.length - 1];
      let n = 0;
      for (const x of this.keys) if (x === k) n++;
      if (n >= 3) return { over: true, result: 'd', reason: 'repetition', legal, check };
      return { over: false, legal, check };
    }

    san(m, legal = this.moves()) {
      let s;
      if (m.flag === 'k') s = 'O-O';
      else if (m.flag === 'q') s = 'O-O-O';
      else {
        const t = m.p.toUpperCase();
        if (t === 'P') {
          s = (m.cap ? 'abcdefgh'[m.from & 7] + 'x' : '') + sqName(m.to);
          if (m.promo) s += '=' + m.promo.toUpperCase();
        } else {
          s = t;
          const amb = legal.filter(o => o.p === m.p && o.to === m.to && o.from !== m.from);
          if (amb.length) {
            const sf = amb.some(o => (o.from & 7) === (m.from & 7));
            const sr = amb.some(o => (o.from >> 3) === (m.from >> 3));
            s += !sf ? 'abcdefgh'[m.from & 7] : !sr ? String((m.from >> 3) + 1) : sqName(m.from);
          }
          if (m.cap) s += 'x';
          s += sqName(m.to);
        }
      }
      this.make(m);
      const n = this.moves().length, c = this.inCheck();
      this.undo();
      return s + (c ? (n ? '+' : '#') : '');
    }

    play(m) {
      const san = this.san(m);
      this.make(m);
      this.hist.push({ m, san });
      return san;
    }

    takeback() {
      if (!this.hist.length) return null;
      this.undo();
      return this.hist.pop();
    }

    fromUci(u) {
      if (!u || u.length < 4) return null;
      const from = sqIdx(u.slice(0, 2)), to = sqIdx(u.slice(2, 4)), pr = u[4];
      return this.moves().find(m => m.from === from && m.to === to && (!m.promo || m.promo.toLowerCase() === (pr || 'q'))) || null;
    }
  }

  const uci = m => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');

  // ---------- evaluasi ----------
  const PST = {
    p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    ke: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
      -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
  };

  // skor dari sudut pandang pihak yang jalan
  function evaluate(c) {
    const b = c.board;
    let npm = 0;
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (p) { const t = p.toLowerCase(); if (t !== 'p' && t !== 'k') npm += VAL[t]; }
    }
    const endgame = npm <= 1300;
    let sc = 0;
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p) continue;
      let t = p.toLowerCase();
      const tbl = t === 'k' && endgame ? PST.ke : PST[t];
      const f = s & 7, r = s >> 3;
      if (isW(p)) sc += VAL[t] + tbl[(7 - r) * 8 + f];
      else sc -= VAL[t] + tbl[r * 8 + f];
    }
    return c.turn === 'w' ? sc : -sc;
  }

  const LEVELS = {
    easy: { depth: 1, qs: false, noise: 140, blunder: 0.3, time: 800 },
    medium: { depth: 2, qs: true, noise: 30, blunder: 0.04, time: 1500 },
    hard: { depth: 6, qs: true, noise: 0, blunder: 0, time: 2200 },
  };

  function bestMove(fen, level) {
    const opt = LEVELS[level] || LEVELS.medium;
    const c = new Chess(fen);
    c.track = false;
    const root = c.moves();
    if (!root.length) return null;
    if (root.length === 1) return uci(root[0]);
    if (Math.random() < opt.blunder) return uci(root[(Math.random() * root.length) | 0]);

    const deadline = Date.now() + opt.time;
    const ABORT = {};
    let nodes = 0;
    const order = ms => {
      for (const m of ms) {
        m.sc = (m.cap ? 10 * VAL[m.cap.toLowerCase()] - VAL[m.p.toLowerCase()] + 1000 : 0) + (m.promo ? 800 : 0);
      }
      return ms.sort((a, b) => b.sc - a.sc);
    };
    const tick = () => { if ((++nodes & 1023) === 0 && Date.now() > deadline) throw ABORT; };

    function qs(alpha, beta, ply) {
      tick();
      const sp = evaluate(c);
      if (sp >= beta) return beta;
      if (sp > alpha) alpha = sp;
      if (ply > 6) return alpha;
      for (const m of order(c.moves(true))) {
        c.make(m);
        const v = -qs(-beta, -alpha, ply + 1);
        c.undo();
        if (v >= beta) return beta;
        if (v > alpha) alpha = v;
      }
      return alpha;
    }

    function nm(depth, alpha, beta, ply) {
      tick();
      if (depth <= 0) return opt.qs ? qs(alpha, beta, 0) : evaluate(c);
      const ms = c.moves();
      if (!ms.length) return c.inCheck() ? -MATE + ply : 0;
      if (c.half >= 100) return 0;
      let best = -Infinity;
      for (const m of order(ms)) {
        c.make(m);
        const v = -nm(depth - 1, -beta, -alpha, ply + 1);
        c.undo();
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    let best = order(root)[0];
    for (let d = 1; d <= opt.depth; d++) {
      try {
        let alpha = -Infinity, cand = null, candV = -Infinity;
        const list = root.slice().sort((a, b) => (a === best ? -1 : b === best ? 1 : 0));
        for (const m of list) {
          c.make(m);
          // dengan noise, tiap langkah dinilai dengan jendela penuh supaya acaknya adil
          let v = opt.noise ? -nm(d - 1, -Infinity, Infinity, 1) : -nm(d - 1, -Infinity, -alpha, 1);
          c.undo();
          if (opt.noise) v += (Math.random() * 2 - 1) * opt.noise;
          if (v > candV) { candV = v; cand = m; }
          if (v > alpha) alpha = v;
        }
        best = cand;
        if (candV > MATE - 100) break; // sudah ketemu mat
      } catch (e) {
        if (e !== ABORT) throw e;
        break;
      }
      if (Date.now() > deadline) break;
    }
    return uci(best);
  }

  const api = { Chess, bestMove, uci, sqName, sqIdx, colorOf, VAL, START };
  root.ChessEngine = api;

  // mode Web Worker
  if (typeof window === 'undefined' && typeof importScripts === 'function') {
    self.onmessage = e => {
      const { id, fen, level } = e.data;
      self.postMessage({ id, move: bestMove(fen, level) });
    };
  }
})(typeof self !== 'undefined' ? self : this);
