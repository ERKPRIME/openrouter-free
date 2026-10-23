# Restricts a router install to the current user, SYSTEM and Administrators. Provider keys live in
# providers.env/ranker.env, and the default install directory sits under the user profile, where the
# inherited ACL can include other local users or a broadly readable parent.
#
# This is best effort: FAT/exFAT, some network shares and policy-locked profile directories cannot
# store ACLs. Install remains usable in that case, with a warning rather than a failed install.
function Get-ProtectiveAccessRules {
    param([bool]$Directory = $false, [string[]]$SidList = @())
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    if ($Directory) {
        $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    }
    $rules = @()
    foreach ($value in $SidList) {
        $sid = [System.Security.Principal.SecurityIdentifier]::new($value)
        $rules += [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
    }
    return $rules
}

function Set-RouterAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop

    # The current user always keeps access. SYSTEM and the built-in Administrators group keep the
    # ability to recover an install after a profile problem; nobody else is granted access.
    $sids = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        "S-1-5-18",
        "S-1-5-32-544"
    )
    $sids = @($sids | Select-Object -Unique)

    # Re-applying an identical protected DACL needs SeSecurityPrivilege on Windows PowerShell 5.1
    # (Set-Acl writes through the security descriptor path), so an upgrade would warn even though
    # nothing is wrong. Leave an ACL that already has exactly these rules alone.
    $expectedInherit = [System.Security.AccessControl.InheritanceFlags]::None
    if ($item.PSIsContainer) {
        $expectedInherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    }
    $current = @($acl.Access)
    $alreadySet = $acl.AreAccessRulesProtected -and $current.Count -eq $sids.Count
    if ($alreadySet) {
        foreach ($rule in $current) {
            if ($rule.IsInherited -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $expectedInherit -or
                $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
                $alreadySet = $false
                break
            }
            $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            if (-not ($sids -contains $ruleSid)) {
                $alreadySet = $false
                break
            }
        }
    }
    if ($alreadySet) { return }

    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleAll($rule)
    }
    foreach ($rule in (Get-ProtectiveAccessRules -Directory $item.PSIsContainer -SidList $sids)) {
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Protect-RouterPath {
    param([Parameter(Mandatory = $true)][string[]]$Path)
    foreach ($one in $Path) {
        if (-not (Test-Path -LiteralPath $one)) { continue }
        try {
            Set-RouterAcl -Path $one
        } catch {
            Write-Warning "could not restrict permissions on ${one}: $($_.Exception.Message)"
        }
    }
}
