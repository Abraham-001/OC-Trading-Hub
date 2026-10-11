$ErrorActionPreference = 'Stop'
$path = Join-Path (Get-Location) 'script.js'
if (-not (Test-Path -LiteralPath $path)) {
    throw 'script.js was not found. Open PowerShell in the folder containing the OC Trading Hub website files, then run this script again.'
}
$content = [System.IO.File]::ReadAllText($path) -replace "`r`n", "`n"
$original = $content

function Replace-Once([string]$Old, [string]$New, [string]$Label) {
    $script:countMatches = ([regex]::Matches($script:content, [regex]::Escape($Old))).Count
    if ($script:countMatches -ne 1) {
        throw "${Label}: expected exactly one match, found $script:countMatches. No changes have been written. Make sure this is the current OC Trading Hub script.js."
    }
    $script:content = $script:content.Replace($Old, $New)
}

$oldPrice = @'
    if (n !== 0 && Math.abs(n) < 0.0001) return '$' + n.toExponential(2);
'@
$newPrice = @'
    if (n !== 0 && Math.abs(n) < 0.0001) {
      const decimals = Math.min(12, Math.max(6, Math.ceil(-Math.log10(Math.abs(n))) + 2));
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
    }
'@
Replace-Once $oldPrice $newPrice 'Tiny-price formatting'

$oldConstants = @'
  const DEX_BASE = 'https://api.dexscreener.com/latest/dex/search?q=';
  const CACHE_SECONDS = 60;
  const MARKET_QUERIES = [
    { query: 'SOL/USDC', label: 'SOL / USDC' },
    { query: 'BONK/SOL', label: 'BONK / SOL' },
    { query: 'JUP/SOL', label: 'JUP / SOL' },
    { query: 'WIF/SOL', label: 'WIF / SOL' }
  ];
'@
$newConstants = @'
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
'@
Replace-Once $oldConstants $newConstants 'Featured pair configuration'

$oldPairFunctions = @'
  function liquidity(pair) { return Number(pair?.liquidity?.usd) || 0; }
  function solanaOnly(pair) { return String(pair?.chainId || '').toLowerCase() === 'solana'; }
  function exactPair(pair, query) {
    const terms = String(query).toUpperCase().split('/').map(s => s.trim());
    if (terms.length !== 2) return false;
    const base = String(pair?.baseToken?.symbol || '').toUpperCase();
    const quote = String(pair?.quoteToken?.symbol || '').toUpperCase();
    return base === terms[0] && quote === terms[1];
  }
  function marketPair(data, item) {
    return (data.pairs || []).filter(solanaOnly).filter(pair => exactPair(pair, item.query)).sort((a, b) => liquidity(b) - liquidity(a))[0] || null;
  }
'@
$newPairFunctions = @'
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
'@
Replace-Once $oldPairFunctions $newPairFunctions 'Canonical token-pair validation'

# Match the live market-loading call exactly, so this patch cannot hit unrelated searches.
$actualCall = "      try { const data = await searchDex(item.query, force); return { item, pair: marketPair(data, item), error: '' }; }"
$newCall = "      try { const data = await fetchCanonicalPools(item, force); return { item, pair: marketPair(data, item), error: '' }; }"
Replace-Once $actualCall $newCall 'Featured market data request'

if ($content -eq $original) { throw 'No changes were produced. The source file was left untouched.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path (Get-Location) ("script.js.before-market-upgrade-$stamp.bak")
[System.IO.File]::Copy($path, $backup, $false)
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))

# Basic post-write checks catch incomplete patches before upload.
$check = [System.IO.File]::ReadAllText($path)
foreach ($required in @('DEX_TOKEN_PAIRS_BASE', 'SOLANA_MINTS', 'canonicalPair(pair, item)', 'fetchCanonicalPools(item, force)', 'minimumFractionDigits: decimals')) {
    if (-not $check.Contains($required)) { Copy-Item -LiteralPath $backup -Destination $path -Force; throw "Validation failed ($required). The original script.js has been restored." }
}
if ($check.Contains("n.toExponential(2)")) { Copy-Item -LiteralPath $backup -Destination $path -Force; throw 'Scientific-notation formatter is still present. The original script.js has been restored.' }
Write-Host ''
Write-Host 'SUCCESS: Market dashboard patch applied.' -ForegroundColor Green
Write-Host 'Updated file: script.js'
Write-Host ('Backup file:  ' + [System.IO.Path]::GetFileName($backup))
Write-Host 'Featured pairs now validate canonical token mint addresses; very small prices display as decimals.'
Write-Host 'Next: upload the updated script.js to GitHub, replacing the existing file.'
