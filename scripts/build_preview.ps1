# Builds a standalone, offline-viewable preview.html from Index.html:
#   1. swaps the Google Fonts <link> for locally embedded woff2 @font-face rules
#   2. injects the demo fixture + a fake google.script.run so the page self-populates
# Preview-only tooling — not part of the deployed Apps Script app.
param(
  [string]$Fixture = '_preview_boot.js',   # -Fixture _omp_boot.js builds against the real workbook
  [string]$Out     = 'preview.html'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false)

$index = [System.IO.File]::ReadAllText((Join-Path $root 'Index.html'), [System.Text.Encoding]::UTF8)
$fonts = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\fonts.css'), [System.Text.Encoding]::UTF8)
$boot  = [System.IO.File]::ReadAllText((Join-Path $root $Fixture), [System.Text.Encoding]::UTF8)

# the standalone page has no host to apply the model for it
$boot = $boot -replace '(?m)^\s*window\.__applyBoot\(MODEL\);\s*$', ''
$boot = $boot -replace '(?m)^\s*if\(window\.__applyBoot\)window\.__applyBoot\(MODEL\);\s*$', ''

# 1. embed the fonts, then drop the now-dead preconnects so the file is fully offline
$linkPattern = '(?m)^<link href="https://fonts\.googleapis\.com/css2[^"]*" rel="stylesheet">\s*$'
if ($index -notmatch $linkPattern) { throw 'Google Fonts <link> not found in Index.html' }
$index = [regex]::Replace($index, $linkPattern, { param($m) "<style>`n$fonts`n</style>" }, 1)
$index = [regex]::Replace($index, '(?m)^<link rel="preconnect" href="https://fonts\.[^"]*"[^>]*>\r?\n', '')

# 2. inject fixture + backend shim ahead of the app script
$shim = @"
<script>
$boot
(function(){
  var S=null,F=null,proxy;
  proxy=new Proxy({},{get:function(t,k){
    if(k==='withSuccessHandler')return function(f){S=f;return proxy;};
    if(k==='withFailureHandler')return function(f){F=f;return proxy;};
    return function(payload){
      setTimeout(function(){
        if(k==='apiBootstrap'){S(window.__MODEL);}
        else{S({ok:false,error:'Static preview - writes are disabled here.'});}
      },40);
      return proxy;
    };
  }});
  window.google={script:{run:proxy}};
})();
</script>
<script>
"@
$marker = "'use strict';"
$idx = $index.IndexOf($marker)
if ($idx -lt 0) { throw "app script marker not found" }
# rewind past the <script> tag that opens the app block
$open = $index.LastIndexOf('<script>', $idx)
if ($open -lt 0) { throw 'app <script> opener not found' }
$index = $index.Substring(0, $open) + $shim + $index.Substring($open + '<script>'.Length)

$out = Join-Path $root $Out
[System.IO.File]::WriteAllText($out, $index, $utf8)
Write-Output ("preview.html written: {0} KB" -f [math]::Round((Get-Item $out).Length / 1KB))
