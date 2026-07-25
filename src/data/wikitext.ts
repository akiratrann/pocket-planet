// Lightweight MediaWiki wikitext parsing utilities.
// Wikivoyage encodes every point of interest as a template invocation, e.g.
//   {{see | name=Kinkaku-ji | lat=35.03 | long=135.72 | content=The Golden Pavilion... }}
// These helpers extract those templates (handling nesting) and convert prose
// wikitext into readable plain text.

export interface ParsedTemplate {
  name: string;
  params: Record<string, string>;
  index: number;
}

/** Split a string on `sep`, ignoring separators nested inside {{}} or [[]]. */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let brace = 0;
  let bracket = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const two = s[i] + (s[i + 1] ?? '');
    if (two === '{{') {
      brace++;
      i++;
    } else if (two === '}}') {
      brace--;
      i++;
    } else if (two === '[[') {
      bracket++;
      i++;
    } else if (two === ']]') {
      bracket--;
      i++;
    } else if (s[i] === sep && brace === 0 && bracket === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

/** Index of the first top-level `=` (the key/value separator), or -1. */
function firstTopLevelEquals(s: string): number {
  let brace = 0;
  let bracket = 0;
  for (let i = 0; i < s.length; i++) {
    const two = s[i] + (s[i + 1] ?? '');
    if (two === '{{' || two === '[[') {
      if (two === '{{') brace++;
      else bracket++;
      i++;
    } else if (two === '}}' || two === ']]') {
      if (two === '}}') brace--;
      else bracket--;
      i++;
    } else if (s[i] === '=' && brace === 0 && bracket === 0) {
      return i;
    }
  }
  return -1;
}

/** Find every top-level template invocation in the text, with nesting support. */
export function findTemplates(text: string): ParsedTemplate[] {
  const results: ParsedTemplate[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === '{' && text[j + 1] === '{') {
          depth++;
          j++;
        } else if (text[j] === '}' && text[j + 1] === '}') {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      const inner = text.slice(i + 2, j - 1);
      const parts = splitTopLevel(inner, '|');
      const name = (parts[0] ?? '').trim().toLowerCase();
      const params: Record<string, string> = {};
      let positional = 0;
      for (let k = 1; k < parts.length; k++) {
        const part = parts[k];
        const eq = firstTopLevelEquals(part);
        if (eq >= 0) {
          const key = part.slice(0, eq).trim().toLowerCase();
          params[key] = part.slice(eq + 1).trim();
        } else {
          params[String(positional++)] = part.trim();
        }
      }
      results.push({ name, params, index: i });
      i = j;
    }
  }
  return results;
}

/** Repeatedly strip innermost templates until none remain. */
function stripTemplates(s: string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    out = out.replace(/\{\{[^{}]*\}\}/g, '');
  } while (out !== prev);
  return out;
}

/** Convert wikitext prose into readable plain text. */
export function cleanWikitext(input: string): string {
  if (!input) return '';
  let s = input;
  // Comments + references.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<ref[^>]*\/>/gi, '');
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  // Templates (inline: convert, lang, etc.) — just remove.
  s = stripTemplates(s);
  // Files/images and categories.
  s = s.replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '');
  // Wiki links: [[target|label]] -> label, [[target]] -> target.
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // External links: [http://x label] -> label, [http://x] -> ''.
  s = s.replace(/\[(?:https?:)?\/\/\S+\s+([^\]]+)\]/g, '$1');
  s = s.replace(/\[(?:https?:)?\/\/\S+\]/g, '');
  // Bold / italic.
  s = s.replace(/'''''(.*?)'''''/g, '$1');
  s = s.replace(/'''(.*?)'''/g, '$1');
  s = s.replace(/''(.*?)''/g, '$1');
  // Remaining HTML tags + entities.
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  // Bullet / heading leftovers and whitespace.
  s = s.replace(/^[*#:;]+\s*/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

export interface Sections {
  intro: string;
  /** Level-2 section title (lowercased) -> raw wikitext body. */
  sections: Record<string, string>;
}

/** Split an article into its lead paragraph and level-2 sections. */
export function splitSections(wikitext: string): Sections {
  const headingRe = /^==\s*([^=].*?)\s*==\s*$/gm;
  const matches: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(wikitext)) !== null) {
    matches.push({
      title: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  const intro = (matches.length ? wikitext.slice(0, matches[0].start) : wikitext).trim();
  const sections: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const bodyStart = matches[i].end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].start : wikitext.length;
    sections[matches[i].title.toLowerCase()] = wikitext.slice(bodyStart, bodyEnd).trim();
  }
  return { intro, sections };
}

/** Parse a numeric coordinate that may include stray characters. */
export function parseCoord(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
