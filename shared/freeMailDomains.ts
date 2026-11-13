/**
 * Free and consumer mail domains (§B.3): an address at one of these never links a contact to a
 * company by its domain ("gmail.com" is not a company). Lower case; checked with `isFreeMailDomain`,
 * which also treats any subdomain of one as free.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.fr", "yahoo.de", "ymail.com", "rocketmail.com",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "outlook.com", "outlook.fr", "live.com", "live.co.uk", "msn.com", "passport.com",
  "aol.com", "aim.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.io", "zoho.com",
  "zohomail.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "mail.ru", "yandex.com", "yandex.ru", "inbox.ru", "list.ru", "bk.ru",
  "qq.com", "163.com", "126.com", "sina.com", "rediffmail.com", "fastmail.com", "fastmail.fm", "hey.com", "duck.com", "mailbox.org",
  "posteo.de", "orange.fr", "free.fr", "laposte.net", "sfr.fr", "t-online.de", "freenet.de", "libero.it", "virgilio.it", "tiscali.it",
  "btinternet.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "charter.net", "earthlink.net", "naver.com",
  "daum.net", "hanmail.net", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "bol.com.br", "uol.com.br", "terra.com.br", "example.com",
  "example.org", "example.net", "example.test"
]);

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  const lower = domain.toLowerCase();
  if (FREE_MAIL_DOMAINS.has(lower)) return true;
  const parts = lower.split(".");
  for (let index = 1; index < parts.length - 1; index += 1) if (FREE_MAIL_DOMAINS.has(parts.slice(index).join("."))) return true;
  return false;
}
