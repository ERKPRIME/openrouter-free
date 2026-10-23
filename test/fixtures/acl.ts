// Windows has no Unix mode bits for privacy. These helpers inspect the real DACL and use SIDs, not
// localized group names, so the tests behave the same on an English, Spanish or any other Windows.
import assert from "node:assert/strict"
import path from "node:path"
import { execFileSync } from "node:child_process"

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

const BROAD_GROUPS = new Set([
  "S-1-1-0", // Everyone
  "S-1-5-32-545", // BUILTIN\Users
  "S-1-5-11", // NT AUTHORITY\Authenticated Users
])

export function assertPrivateAcl(file: string, label = file) {
  const script = `
$acl = Get-Acl -LiteralPath $env:ACL_FILE
$acl.Access | ForEach-Object {
  $sid = try {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $_.IdentityReference.Value
  }
  "{0}|{1}|{2}" -f $sid, $_.AccessControlType, $_.IsInherited
}
`
  const out = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ACL_FILE: file },
  })
  const rules = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sid = "", type = "", inherited = ""] = line.split("|")
      return { sid, type, inherited: inherited === "True" }
    })

  assert.ok(rules.length > 0, `${label}: the ACL has access rules`)
  for (const rule of rules) {
    assert.ok(!BROAD_GROUPS.has(rule.sid), `${label}: no access for broad group ${rule.sid}`)
  }
  assert.ok(
    rules.some((rule) => rule.inherited),
    `${label}: the ACL inherits from the user profile`,
  )
}
