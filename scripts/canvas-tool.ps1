[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Action,
  [string]$Query,
  [string]$Url,
  [string]$Slug,
  [string]$FileId,
  [string]$ModuleId,
  [int]$Page,
  [string]$Pages,
  [string]$Path,
  [string]$ProblemNumbers,
  [string]$InputFile
)

$toolPath = Join-Path $PSScriptRoot 'canvas-tool.mjs'
$inputNames = @()
if ($PSBoundParameters.ContainsKey('Query')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_QUERY = $Query; $inputNames += 'Query' }
if ($PSBoundParameters.ContainsKey('Url')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_URL = $Url; $inputNames += 'Url' }
if ($PSBoundParameters.ContainsKey('Slug')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_SLUG = $Slug; $inputNames += 'Slug' }
if ($PSBoundParameters.ContainsKey('FileId')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_FILE_ID = $FileId; $inputNames += 'FileId' }
if ($PSBoundParameters.ContainsKey('ModuleId')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_MODULE_ID = $ModuleId; $inputNames += 'ModuleId' }
if ($PSBoundParameters.ContainsKey('Page')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_PAGE = [string]$Page; $inputNames += 'Page' }
if ($PSBoundParameters.ContainsKey('Pages')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_PAGES = $Pages; $inputNames += 'Pages' }
if ($PSBoundParameters.ContainsKey('Path')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_PATH = $Path; $inputNames += 'Path' }
if ($PSBoundParameters.ContainsKey('ProblemNumbers')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_PROBLEM_NUMBERS = $ProblemNumbers; $inputNames += 'ProblemNumbers' }
if ($PSBoundParameters.ContainsKey('InputFile')) { $env:SCHOOL_DASHBOARD_TOOL_INPUT_FILE = $InputFile; $inputNames += 'InputFile' }
$env:SCHOOL_DASHBOARD_TOOL_INPUT_NAMES = $inputNames -join ','

# Windows PowerShell 5.1 can reinterpret embedded quotes when invoking a native executable even
# from an argument array. Values therefore cross this one process boundary through environment
# variables; only the fixed action and --input-env marker are command-line arguments.
& node $toolPath $Action --input-env
exit $LASTEXITCODE
