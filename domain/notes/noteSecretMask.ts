/**
 * Hide credentials in note text before it leaves the app for an external AI.
 *
 * Deliberately conservative: only values that are labelled as secrets, URL
 * passwords, bearer tokens and private-key blocks are masked. The label and
 * the surrounding text stay readable so a note can still be organized; only
 * the secret value is replaced.
 */
export const NOTE_SECRET_MASK = "[hidden]";

const SECRET_LABEL_SOURCE = [
  "pass(?:word|wd|phrase)?",
  "pwd",
  "secret(?:[ _-]?key)?",
  "(?:api|access|private|auth|client)[ _-]?(?:key|token|secret)",
  "token",
  "credentials?",
  "密码",
  "口令",
  "密钥",
  "秘钥",
  "令牌",
  "授权码",
  "验证码",
  "密碼",
  "金鑰",
].join("|");

// label, optional closing markup/quote, separator, then the value up to the
// next whitespace, quote or full-width delimiter. ASCII punctuation is part of
// the value: real passwords contain commas, semicolons and brackets, and
// masking only the part before one would leak the rest.
const LABELLED_SECRET_RE = new RegExp(
  String.raw`((?:^|[^\p{L}\p{N}_])(?:${SECRET_LABEL_SOURCE})[\*_\x60"']{0,3}\s*(?:[:：=＝]|是|为|為)\s*[\*_\x60"']{0,3})([^\s\x60"'，；）]{1,})`,
  "giu",
);
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)(@)/gi;
const BEARER_RE = /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// Command-line passwords, only for tools where the flag is unambiguous:
// `mkdir -p dir` or `ssh -p 2222` must never be touched.
const CLI_PASSWORD_LINE_RE = /^.*\b(?:mysql|mysqldump|mysqladmin|mariadb|sshpass|redis-cli)\b.*$/gm;
const CLI_PASSWORD_FLAG_RE = /((?:^|\s)(?:-p|--password=|--password\s+|-a\s+|--pass=)\s*)(['"]?)([^\s'"]+)\2/g;

export interface NoteSecretMaskResult {
  text: string;
  maskedCount: number;
}

export function maskNoteSecrets(text: string): NoteSecretMaskResult {
  if (!text) return { text, maskedCount: 0 };
  let maskedCount = 0;
  const count = () => {
    maskedCount += 1;
  };
  let out = text.replace(PRIVATE_KEY_RE, () => {
    count();
    return NOTE_SECRET_MASK;
  });
  out = out.replace(URL_PASSWORD_RE, (_match, head: string, _secret: string, tail: string) => {
    count();
    return `${head}${NOTE_SECRET_MASK}${tail}`;
  });
  out = out.replace(BEARER_RE, (_match, head: string) => {
    count();
    return `${head}${NOTE_SECRET_MASK}`;
  });
  out = out.replace(LABELLED_SECRET_RE, (match, head: string, value: string) => {
    if (value === NOTE_SECRET_MASK || value.startsWith("[hidden")) return match;
    count();
    return `${head}${NOTE_SECRET_MASK}`;
  });
  out = out.replace(CLI_PASSWORD_LINE_RE, (line) =>
    line.replace(CLI_PASSWORD_FLAG_RE, (match, head: string, quote: string, value: string) => {
      if (value.startsWith("[hidden")) return match;
      // redis-cli -a is the password; for the others only -p / --password is.
      if (/-a\s+$/.test(head) && !/\bredis-cli\b/.test(line)) return match;
      count();
      return `${head}${quote}${NOTE_SECRET_MASK}${quote}`;
    }),
  );
  return { text: out, maskedCount };
}
