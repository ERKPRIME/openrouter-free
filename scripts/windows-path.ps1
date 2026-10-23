# PATH merging for install-windows.ps1. Kept in a tiny dot-sourced file so the tests can exercise the
# exact logic without writing the real user environment.
function Add-FrontOfPath {
    param(
        [string]$PathValue,
        [string]$Directory
    )

    $target = $Directory.TrimEnd('\')
    $entries = @()
    if ($PathValue) {
        $entries = @($PathValue -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $target })
    }
    # The array wrapper around $Directory is essential: a bare string + array would concatenate the
    # first entry without a semicolon and corrupt the user PATH.
    return ((@($Directory) + $entries) -join ';')
}
