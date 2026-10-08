// Print a PENNY_USERS entry for one account. The password is read from stdin so it
// never lands in shell history:   node scripts/hash-password.ts Auditor1 "Test Auditor" auditor
import { hashPassword, ROLES, type Role } from "../src/auth/auth.ts";

const [username, displayName = username, role = "auditor"] = process.argv.slice(2);
if (!username || !ROLES.includes(role as Role)) {
  console.error("usage: node scripts/hash-password.ts <username> [display name] [auditor|director|agency|business]  (password on stdin)");
  process.exit(1);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const password = input.replace(/\r?\n$/, "");
  if (password.length < 6) {
    console.error("password must be at least 6 characters");
    process.exit(1);
  }
  console.log(JSON.stringify({ username, displayName, role, passwordHash: hashPassword(password) }));
});
