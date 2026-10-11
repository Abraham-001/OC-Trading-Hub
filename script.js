(() => {
  'use strict';
  const CONFIG = window.OC_CONFIG || {};
  const DEX_BASE = 'https://api.dexscreener.com/latest/dex/search?q=';
  const DEX_TOKEN_PAIRS_BASE = 'https://api.dexscreener.com/token-pairs/v1/solana/';
  const CACHE_SECONDS = 60;
  // Canonical Solana mint addresses reduce the risk of showing look-alike tokens.
  const SOLANA_MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
  };
  const MARKET_QUERIES = [
    { query: 'SOL/USDC', label: 'SOL / USDC', baseSymbol: 'SOL', quoteSymbol: 'USDC' },
    { query: 'BONK/SOL', label: 'BONK / SOL', baseSymbol: 'BONK', quoteSymbol: 'SOL' },
    { query: 'JUP/SOL', label: 'JUP / SOL', baseSymbol: 'JUP', quoteSymbol: 'SOL' },
    { query: 'WIF/SOL', label: 'WIF / SOL', baseSymbol: 'WIF', quoteSymbol: 'SOL' }
  ];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

  function usd(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n !== 0 && Math.abs(n) < 0.0001) {
      const decimals = Math.min(12, Math.max(6, Math.ceil(-Math.log10(Math.abs(n))) + 2));
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
    }
    const precision = digits ?? (Math.abs(n) < 0.01 ? 6 : Math.abs(n) < 1 ? 4 : 2);
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: precision });
  }
  function compact(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return usd(n);
  }
  function pct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : '—';
  }
  function dateLabel(date) {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
    catch { return date.toISOString(); }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function status(selector, text) { const node = $(selector); if (node) node.textContent = text; }

  function setupNavigation() {
    const toggle = $('#menuToggle');
    const nav = $('#primaryNav');
    if (!toggle || !nav) return;
    const close = () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    };
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    });
    $$('a', nav).forEach(link => link.addEventListener('click', close));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    const page = document.body.dataset.page;
    const navKey = page === 'index' ? 'home' : page === 'risk-lab' ? 'risk' : page;
    const active = $('[data-nav="' + navKey + '"]');
    if (active) active.classList.add('active');
  }
  function setupInstagramLinks() {
    let url = '';
    try {
      const candidate = new URL(String(CONFIG.instagramUrl || ''));
      if (candidate.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(candidate.hostname.toLowerCase()) && candidate.pathname.length > 1) url = candidate.href;
    } catch { /* Missing URL is expected until the account link is supplied. */ }
    $$('[data-instagram-link]').forEach(link => {
      if (url) {
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.removeAttribute('aria-disabled'); link.classList.remove('is-disabled');
        link.textContent = link.hasAttribute('data-instagram-label') ? 'Open OC on Instagram ↗' : 'OC on Instagram ↗';
      } else {
        link.href = 'contact.html#instagram-status'; link.removeAttribute('target');
        link.setAttribute('aria-disabled', 'true'); link.classList.add('is-disabled');
        if (link.hasAttribute('data-instagram-label')) link.textContent = 'Instagram profile coming soon ↗';
        else link.textContent = 'Instagram profile pending';
      }
    });
  }
  function readCache(key) {
    try {
      const value = JSON.parse(localStorage.getItem('oc-cache:' + key) || 'null');
      if (!value || Date.now() - value.ts > CACHE_SECONDS * 1000) return null;
      return value.value;
    } catch { return null; }
  }
  function writeCache(key, value) {
    try { localStorage.setItem('oc-cache:' + key, JSON.stringify({ ts: Date.now(), value })); } catch { /* Cache is optional. */ }
  }
  async function searchDex(query, force = false) {
    const q = clean(query, 120);
    if (!q) throw new Error('Enter a token name, symbol, or contract address.');
    const key = q.toLowerCase();
    if (!force) { const cached = readCache(key); if (cached) return cached; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(DEX_BASE + encodeURIComponent(q), { headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('The public provider returned HTTP ' + response.status + '.');
      const data = await response.json();
      if (!data || !Array.isArray(data.pairs)) throw new Error('The provider returned an unexpected response.');
      writeCache(key, data);
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The market-data request timed out.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function fetchCanonicalPools(item, force = false) {
    const mint = SOLANA_MINTS[item.baseSymbol];
    if (!mint) throw new Error('No canonical mint configured for ' + item.baseSymbol + '.');
    const key = 'solana-pools:' + mint;
    if (!force) {
      const cached = readCache(key);
      if (cached) return cached;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(DEX_TOKEN_PAIRS_BASE + encodeURIComponent(mint), {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('The public provider returned HTTP ' + response.status + '.');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('The provider returned an unexpected pool response.');
      writeCache(key, data);
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The market-data request timed out.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function liquidity(pair) { return Number(pair?.liquidity?.usd) || 0; }
  function solanaOnly(pair) { return String(pair?.chainId || '').toLowerCase() === 'solana'; }
  function canonicalPair(pair, item) {
    return !!SOLANA_MINTS[item.baseSymbol] && !!SOLANA_MINTS[item.quoteSymbol] &&
      String(pair?.baseToken?.address || '') === SOLANA_MINTS[item.baseSymbol] &&
      String(pair?.quoteToken?.address || '') === SOLANA_MINTS[item.quoteSymbol];
  }
  function marketPair(data, item) {
    return (Array.isArray(data) ? data : []).filter(solanaOnly).filter(pair => canonicalPair(pair, item)).sort((a, b) => liquidity(b) - liquidity(a))[0] || null;
  }
  function safeDexUrl(pair) {
    try {
      const u = new URL(pair?.url || '');
      if (u.protocol === 'https:' && (u.hostname === 'dexscreener.com' || u.hostname.endsWith('.dexscreener.com'))) return u.href;
    } catch { /* Ignore malformed external URLs. */ }
    return '';
  }
  function marketCard(item, pair, error = '') {
    const card = el('article', 'market-card');
    card.append(el('span', 'market-symbol', item.label));
    if (!pair) {
      card.append(el('strong', '', error ? 'Data unavailable' : 'No matching pair'));
      card.append(el('span', 'market-help', error || 'No matching Solana pool was returned for this pair.'));
      return card;
    }
    card.append(el('strong', 'market-price', usd(pair.priceUsd)));
    const change = Number(pair.priceChange?.h24);
    card.append(el('span', 'market-change' + (Number.isFinite(change) && change < 0 ? ' negative' : ''), Number.isFinite(change) ? pct(change) + ' · 24h' : '24h change unavailable'));
    const metrics = el('div', 'market-metrics');
    metrics.append(el('span', '', 'Liq ' + compact(pair.liquidity?.usd)), el('span', '', 'Vol ' + compact(pair.volume?.h24)));
    card.append(metrics);
    const linkUrl = safeDexUrl(pair);
    if (linkUrl) {
      const link = el('a', 'market-open', 'Open pair ↗'); link.href = linkUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', 'Open ' + item.label + ' on DEX Screener in a new tab'); card.append(link);
    }
    return card;
  }
  async function loadMarketBoard(force = false) {
    const board = $('[data-market-board]');
    if (!board) return;
    status('#marketFeedStatus', 'Requesting public pair data…');
    status('#marketPageStatus', 'Requesting public pair data…');
    const results = await Promise.all(MARKET_QUERIES.map(async item => {
      try { const data = await fetchCanonicalPools(item, force); return { item, pair: marketPair(data, item), error: '' }; }
      catch (e) { return { item, pair: null, error: clean(e?.message || 'Request failed.', 180) }; }
    }));
    board.replaceChildren(...results.map(r => marketCard(r.item, r.pair, r.error)));
    const successes = results.filter(r => r.pair).length;
    const label = successes ? `${successes} of ${results.length} pairs available · ${dateLabel(new Date())}` : 'No pair data returned. Check the connection or retry.';
    status('#marketFeedStatus', label);
    status('#marketPageStatus', successes ? `${successes} of ${results.length} pairs available` : 'No data returned — retry');
    status('#heroDataStatus', successes ? 'Available' : 'Unavailable');
    status('#marketUpdatedAt', dateLabel(new Date()));
  }
  const CHAIN_NAMES = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', polygon: 'Polygon', arbitrum: 'Arbitrum', optimism: 'Optimism', avalanche: 'Avalanche' };
  function renderPair(pair) {
    const row = el('article', 'pair-result');
    const main = el('div', 'pair-main');
    main.append(el('h3', '', (pair.baseToken?.symbol || 'Unknown') + ' / ' + (pair.quoteToken?.symbol || 'Unknown')));
    main.append(el('p', '', (pair.baseToken?.name || 'Unknown token') + ' · ' + (CHAIN_NAMES[pair.chainId] || clean(pair.chainId, 40))));
    const address = String(pair.baseToken?.address || '');
    if (address) main.append(el('small', '', 'Base contract: ' + (address.length > 30 ? address.slice(0, 7) + '…' + address.slice(-6) : address)));
    row.append(main);
    for (const [label, value] of [['PRICE (USD)', usd(pair.priceUsd)], ['LIQUIDITY', compact(pair.liquidity?.usd)], ['24H VOLUME', compact(pair.volume?.h24)], ['24H CHANGE', pct(pair.priceChange?.h24)]]) {
      const metric = el('div', 'pair-metric'); metric.append(el('div', 'pair-metric-label', label)); const strong = el('strong', '', value);
      if (label === '24H CHANGE' && Number.isFinite(Number(pair.priceChange?.h24))) strong.classList.add(Number(pair.priceChange.h24) < 0 ? 'negative' : 'positive');
      metric.append(strong); row.append(metric);
    }
    const linkUrl = safeDexUrl(pair);
    if (linkUrl) { const link = el('a', '', 'Review pair ↗'); link.href = linkUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    return row;
  }
  function setupTokenSearch() {
    const form = $('#tokenSearchForm'); if (!form) return;
    const input = $('#tokenQuery'), chain = $('#chainFilter'), message = $('#tokenSearchStatus'), results = $('#tokenSearchResults');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const query = clean(input.value, 120);
      if (!query) { message.textContent = 'Enter a token name, symbol, or address.'; return; }
      message.textContent = 'Searching public market data…'; results.replaceChildren();
      try {
        const data = await searchDex(query, true);
        let pairs = (data.pairs || []).filter(p => chain.value === 'all' || String(p.chainId || '').toLowerCase() === chain.value);
        pairs = pairs.sort((a, b) => liquidity(b) - liquidity(a)).slice(0, 20);
        if (!pairs.length) {
          const empty = el('div', 'empty-state'); empty.append(el('span', 'empty-icon', '⌕'), el('h3', '', 'No matching pairs returned'), el('p', '', 'Try another spelling or contract address, or change the chain filter. No result is not proof that a token is safe or unsafe.'));
          results.append(empty); message.textContent = 'No results for this query and chain filter.'; return;
        }
        results.append(...pairs.map(renderPair)); message.textContent = `${pairs.length} pair record(s) returned, sorted by reported liquidity.`;
      } catch (error) {
        const empty = el('div', 'empty-state'); empty.append(el('span', 'empty-icon', '!'), el('h3', '', 'Could not retrieve market data'), el('p', '', clean(error?.message || 'Unknown error.', 200) + ' Check the connection and retry.'));
        results.append(empty); message.textContent = 'Search failed. Do not rely on unavailable data.';
      }
    });
  }
  function setupToolFilters() {
    const buttons = $$('[data-tool-filter]'), cards = $$('[data-tool-category]');
    if (!buttons.length || !cards.length) return;
    buttons.forEach(button => button.addEventListener('click', () => {
      buttons.forEach(b => b.classList.toggle('is-active', b === button));
      cards.forEach(card => { card.hidden = !(button.dataset.toolFilter === 'all' || card.dataset.toolCategory === button.dataset.toolFilter); });
    }));
  }
  function setupBriefBuilder() {
    const form = $('#analysisBriefForm'); if (!form) return;
    const brief = $('#generatedBrief'), output = $('#briefOutput');
    form.addEventListener('submit', event => {
      event.preventDefault();
      const market = clean($('#briefMarket').value, 60), timeframe = clean($('#briefSession').value, 100), bias = clean($('#briefBias').value, 80), dataStatus = clean($('#briefDataStatus').value, 80);
      const evidence = clean($('#briefEvidence').value, 2000) || 'No evidence entered. Add observations before reviewing a setup.';
      const risk = clean($('#briefRisk').value, 80), eventStatus = clean($('#briefEvent').value, 80);
      const lines = ['OC TRADING HUB — STRUCTURED MARKET REVIEW','Market / instrument: ' + market,'Analysis timeframe: ' + timeframe,'Hypothesis: ' + bias,'Data status: ' + dataStatus,'','OBSERVATIONS SUPPLIED',evidence,'','MANDATORY REVIEW QUESTIONS','1. Are the symbol, feed, timeframe, and timestamp correct and current?','2. What evidence supports the hypothesis, and what evidence contradicts it?','3. What specific condition invalidates the hypothesis?','4. Is the target direction consistent with entry and stop?','5. Have spreads, liquidity, fees, slippage, leverage, and relevant events been checked?','6. Is the maximum loss defined and acceptable before any order is considered?','','Risk plan: ' + risk,'Event / calendar status: ' + eventStatus,'','WORKSHEET STATUS: ' + ((dataStatus === 'Current and verified' && risk === 'Yes — written and checked' && eventStatus === 'Calendar checked') ? 'Some checks marked complete by the user; independent verification is still required.' : 'REVIEW INCOMPLETE — resolve unknowns before making a decision.'),'','LIMITATION: This worksheet formats user-supplied text. It does not call an AI model, verify data, forecast prices, or generate a trading signal.'];
      output.textContent = lines.join('\n'); brief.hidden = false;
      brief.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    const copy = $('#copyBrief');
    if (copy) copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(output.textContent); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy brief', 1500); } catch { copy.textContent = 'Select and copy text'; } });
    form.addEventListener('reset', () => { brief.hidden = true; });
  }
  function setupRiskCalculator() {
    const form = $('#riskCalculator'); if (!form) return;
    const number = id => Number($('#' + id).value);
    function calc(event) {
      if (event) event.preventDefault();
      const balance=number('riskBalance'), riskPct=number('riskPercent'), entry=number('riskEntry'), stop=number('riskStop'), target=number('riskTarget'), direction=$('#riskDirection').value, note=$('#riskValidation');
      const error = message => { status('#riskAmountResult','—'); status('#riskPercentResult','Not calculated'); status('#riskUnitsResult','—'); status('#riskNotionalResult','—'); status('#riskDistanceResult','—'); status('#riskRRResult','—'); note.textContent=message; note.classList.add('validation-error'); };
      if (![balance,riskPct,entry,stop,target].every(Number.isFinite) || balance<=0 || riskPct<=0 || riskPct>10 || entry<=0 || stop<=0 || target<=0) return error('Enter positive values. Risk percentage must be above 0 and no more than 10% in this calculator.');
      if (direction === 'long' && stop >= entry) return error('For a long position, stop-loss must be below entry.');
      if (direction === 'short' && stop <= entry) return error('For a short position, stop-loss must be above entry.');
      const distance=Math.abs(entry-stop); if (distance<=0) return error('Entry and stop must be different.');
      const reward=direction==='long' ? target-entry : entry-target; if (reward<=0) return error('Target is on the wrong side: above entry for long, below entry for short.');
      const riskAmount=balance*riskPct/100, units=riskAmount/distance, notional=units*entry, rr=reward/distance;
      status('#riskAmountResult',usd(riskAmount,2)); status('#riskPercentResult',riskPct.toFixed(2)+'% of entered balance'); status('#riskUnitsResult',units.toLocaleString('en-US',{maximumFractionDigits:8})); status('#riskNotionalResult',usd(notional,2)); status('#riskDistanceResult',distance.toLocaleString('en-US',{maximumFractionDigits:8})); status('#riskRRResult',rr.toFixed(2)+'R');
      note.textContent='Estimate excludes fees, spread, slippage, funding, leverage, margin, contract multipliers, and instrument-specific volume rules. Verify before use.'; note.classList.remove('validation-error');
    }
    form.addEventListener('submit',calc); ['riskBalance','riskPercent','riskEntry','riskStop','riskTarget','riskDirection'].forEach(id=>$('#'+id).addEventListener('input',()=>calc())); form.addEventListener('reset',()=>setTimeout(()=>calc(),0)); calc();
  }
  const JOURNAL_KEY='oc-hub:local-journal:v1';
  function readJournal(){try{const items=JSON.parse(localStorage.getItem(JOURNAL_KEY)||'[]');return Array.isArray(items)?items.filter(x=>x&&typeof x==='object').slice(0,200):[]}catch{return[]}}
  function writeJournal(items){localStorage.setItem(JOURNAL_KEY,JSON.stringify(items.slice(0,200)))}
  function renderJournal(){
    const host=$('#journalEntries');if(!host)return;const items=readJournal();status('#journalCount',items.length+(items.length===1?' ENTRY':' ENTRIES'));
    if(!items.length){const box=el('div','empty-state');box.append(el('span','empty-icon','▤'),el('h3','','No journal entries yet'),el('p','','Record a setup or lesson to begin. Data remains in this browser.'));host.replaceChildren(box);return}
    host.replaceChildren(...items.slice().reverse().map(item=>{const row=el('article','journal-entry'),sym=el('div','journal-symbol',clean(item.symbol,40));sym.append(el('small','',clean(item.date,70)));row.append(sym);const body=el('div');body.append(el('strong','',clean(item.outcome,50)),el('p','',clean(item.setup,1500)));row.append(body);const remove=el('button','','Remove');remove.type='button';remove.setAttribute('aria-label','Remove journal entry for '+clean(item.symbol,40));remove.addEventListener('click',()=>{writeJournal(readJournal().filter(x=>x.id!==item.id));renderJournal()});row.append(remove);return row}));
  }
  function setupJournal(){
    const form=$('#journalForm');if(!form)return;
    form.addEventListener('submit',event=>{event.preventDefault();const symbol=clean($('#journalSymbol').value,40),setup=clean($('#journalSetup').value,1500);if(!symbol||!setup)return;let items=readJournal();items.push({id:String(Date.now())+'-'+Math.random().toString(36).slice(2,8),date:dateLabel(new Date()),symbol,outcome:clean($('#journalResult').value,50),setup});if(items.length>200)items=items.slice(-200);try{writeJournal(items)}catch{alert('The browser could not save this entry. Check whether local storage is disabled or full.');return}form.reset();renderJournal()});
    const clear=$('#clearJournal');if(clear)clear.addEventListener('click',()=>{if(!readJournal().length)return;if(!confirm('Delete every OC Trading Hub journal entry stored in this browser? This cannot be undone.'))return;localStorage.removeItem(JOURNAL_KEY);renderJournal()});
    const exportButton=$('#exportJournal');if(exportButton)exportButton.addEventListener('click',()=>{const blob=new Blob([JSON.stringify(readJournal(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='oc-trading-hub-journal.json';document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url)});
    renderJournal();
  }
  function boot(){setupNavigation();setupInstagramLinks();const year=$('#year');if(year)year.textContent=String(new Date().getFullYear());if($('[data-market-board]'))loadMarketBoard(false);const refresh=$('#refreshMarkets');if(refresh)refresh.addEventListener('click',()=>loadMarketBoard(true));setupTokenSearch();setupToolFilters();setupBriefBuilder();setupRiskCalculator();setupJournal()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
