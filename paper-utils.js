// Pure citation parsing utility; external metadata APIs can replace or enrich this later.
(function (global) {
  const DOI_REGEX = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const URL_REGEX = /https?:\/\/[^\s<>"']+/i;
  const YEAR_REGEX = /\b(18|19|20|21)\d{2}\b/;

  function citationParser(input) {
    const rawText = String(input || "").trim();
    if (!rawText) return emptyResult();

    const bibtex = parseBibTeX(rawText);
    const base = bibtex || {};
    const doi = normalizeDoi(base.doi || extractDoi(rawText));
    const url = normalizeUrl(base.url || extractUrl(rawText));
    const year = normalizeYear(base.year || extractYear(rawText));
    const title = cleanTitle(base.title || extractTitle(rawText, year));
    const authors = base.authors?.length ? base.authors : extractAuthors(rawText, year);
    const venue = cleanVenue(base.venue || extractVenue(rawText, title, year));

    return {
      title,
      authors,
      year,
      venue,
      doi,
      url,
      sourceType: bibtex ? "bibtex" : "citation",
    };
  }

  function emptyResult() {
    return {
      title: "",
      authors: [],
      year: undefined,
      venue: "",
      doi: "",
      url: "",
      sourceType: "empty",
    };
  }

  function parseBibTeX(text) {
    if (!/^\s*@\w+\s*\{/i.test(text)) return null;

    const bodyStart = text.indexOf("{");
    const firstComma = text.indexOf(",", bodyStart);
    if (bodyStart < 0 || firstComma < 0) return null;

    const fields = {};
    let index = firstComma + 1;

    while (index < text.length) {
      while (index < text.length && /[\s,]/.test(text[index])) index += 1;
      const keyStart = index;
      while (index < text.length && /[A-Za-z0-9_-]/.test(text[index])) index += 1;
      const key = text.slice(keyStart, index).trim().toLowerCase();
      if (!key) break;

      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (text[index] !== "=") break;
      index += 1;
      while (index < text.length && /\s/.test(text[index])) index += 1;

      const parsed = readBibTeXValue(text, index);
      fields[key] = parsed.value;
      index = parsed.nextIndex;
    }

    return {
      title: fields.title || "",
      authors: parseBibTeXAuthors(fields.author || ""),
      year: fields.year || extractYear(fields.date || ""),
      venue: fields.journal || fields.booktitle || fields.conference || fields.publisher || "",
      doi: fields.doi || "",
      url: fields.url || "",
    };
  }

  function readBibTeXValue(text, start) {
    const opener = text[start];
    if (opener === "{") {
      let depth = 0;
      let value = "";
      let index = start;
      while (index < text.length) {
        const char = text[index];
        if (char === "{") {
          if (depth > 0) value += char;
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
          value += char;
        } else {
          value += char;
        }
        index += 1;
      }
      return { value: cleanBibTeXValue(value), nextIndex: skipComma(text, index) };
    }

    if (opener === '"') {
      let value = "";
      let index = start + 1;
      while (index < text.length) {
        if (text[index] === '"' && text[index - 1] !== "\\") {
          index += 1;
          break;
        }
        value += text[index];
        index += 1;
      }
      return { value: cleanBibTeXValue(value), nextIndex: skipComma(text, index) };
    }

    let index = start;
    while (index < text.length && text[index] !== "," && text[index] !== "}") index += 1;
    return { value: cleanBibTeXValue(text.slice(start, index)), nextIndex: skipComma(text, index) };
  }

  function skipComma(text, index) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === ",") index += 1;
    return index;
  }

  function cleanBibTeXValue(value) {
    return value
      .replace(/\\[{}]/g, "")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseBibTeXAuthors(value) {
    if (!value) return [];
    return value
      .split(/\s+and\s+/i)
      .map((name) => normalizeAuthorName(name))
      .filter(Boolean);
  }

  function normalizeAuthorName(name) {
    const cleaned = cleanLooseText(name);
    if (!cleaned) return "";
    if (!cleaned.includes(",")) return cleaned;
    const [family, ...givenParts] = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
    const given = givenParts.join(" ");
    return [given, family].filter(Boolean).join(" ");
  }

  function extractDoi(text) {
    const doiUrlMatch = text.match(/https?:\/\/(?:dx\.)?doi\.org\/([^\s<>"']+)/i);
    if (doiUrlMatch) return doiUrlMatch[1];
    const match = text.match(DOI_REGEX);
    return match ? match[0] : "";
  }

  function normalizeDoi(value) {
    return cleanLooseText(value)
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[),.;\]]+$/g, "")
      .trim();
  }

  function extractUrl(text) {
    const match = text.match(URL_REGEX);
    return match ? match[0] : "";
  }

  function normalizeUrl(value) {
    return cleanLooseText(value).replace(/[),.;\]]+$/g, "");
  }

  function extractYear(text) {
    const match = String(text || "").match(YEAR_REGEX);
    return match ? Number(match[0]) : undefined;
  }

  function normalizeYear(value) {
    const year = extractYear(value);
    return year ? Number(year) : undefined;
  }

  function extractTitle(text, year) {
    const quoted = text.match(/[“"]([^”"]{8,})[”"]/);
    if (quoted) return quoted[1];

    if (year) {
      const yearPattern = new RegExp(`\\(?${year}\\)?[.)]?\\s*`, "i");
      const afterYear = text.split(yearPattern).slice(1).join(String(year)).trim();
      const fromYear = firstMeaningfulSegment(removeIdentifiers(afterYear));
      if (fromYear) return fromYear;
    }

    const lines = text.split(/\r?\n/).map((line) => cleanLooseText(line)).filter(Boolean);
    const titleLikeLine = lines.find((line) => !line.startsWith("@") && !DOI_REGEX.test(line) && !URL_REGEX.test(line));
    return titleLikeLine || "";
  }

  function extractAuthors(text, year) {
    if (!year) return [];
    const beforeYear = text.split(new RegExp(`\\(?${year}\\)?`))[0] || "";
    const cleaned = cleanLooseText(beforeYear);
    if (!cleaned || /^@/i.test(cleaned)) return [];

    const apaAuthors = parseApaAuthors(beforeYear);
    if (apaAuthors.length) return apaAuthors;

    return cleaned
      .replace(/\bet al\.?/i, "et al.")
      .split(/\s*(?:&|;|\band\b)\s*/i)
      .map((name) => cleanLooseText(name))
      .filter(Boolean);
  }

  function parseApaAuthors(value) {
    const normalized = value.replace(/\s*&\s*/g, ", ");
    const authors = [];
    const authorPattern = /(?:^|,\s*)([^,]+,\s*(?:[A-Z]\.\s*){1,5})/g;
    let match;

    while ((match = authorPattern.exec(normalized)) !== null) {
      authors.push(cleanLooseText(match[1]));
    }

    return authors.length > 1 ? authors : [];
  }

  function extractVenue(text, title, year) {
    let working = removeIdentifiers(text);
    if (year) {
      const yearMatch = working.match(new RegExp(`\\(?${year}\\)?[.)]?\\s*`, "i"));
      if (yearMatch) {
        working = working.slice(yearMatch.index + yearMatch[0].length);
      } else {
        working = working.replace(new RegExp(`\\(?${year}\\)?`, "i"), " ");
      }
    }

    if (title) {
      const titleIndex = working.toLowerCase().indexOf(title.toLowerCase());
      if (titleIndex >= 0) {
        working = working.slice(titleIndex + title.length);
      } else {
        working = working.replace(title, " ");
      }
    }

    const segments = working
      .split(/\.\s+|\n/)
      .map((segment) => cleanLooseText(segment))
      .filter(Boolean);

    const candidate = segments.find((segment) => {
      if (segment.length < 3) return false;
      if (/^(vol|volume|pp|pages|doi|http)/i.test(segment)) return false;
      if (segment.split(/\s+/).length > 14) return false;
      return true;
    });

    return candidate ? candidate.split(/,\s*(?:vol\.?|volume|\d)/i)[0] : "";
  }

  function firstMeaningfulSegment(text) {
    const segments = text
      .split(/\.\s+|\n/)
      .map((segment) => cleanTitle(segment))
      .filter(Boolean);

    return segments.find((segment) => {
      if (DOI_REGEX.test(segment) || URL_REGEX.test(segment)) return false;
      if (/^(doi|retrieved|available|http)/i.test(segment)) return false;
      return segment.length >= 8;
    }) || "";
  }

  function removeIdentifiers(text) {
    return String(text || "")
      .replace(URL_REGEX, " ")
      .replace(DOI_REGEX, " ")
      .replace(/\bdoi:\s*/gi, " ");
  }

  function cleanTitle(value) {
    return cleanLooseText(value)
      .replace(/^title\s*=\s*/i, "")
      .replace(/^["“]|["”]$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanVenue(value) {
    return cleanLooseText(value)
      .replace(/^in:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanLooseText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.;:({["“]+/g, "")
      .replace(/[\s,.;:)}\]"”]+$/g, "")
      .trim();
  }

  global.citationParser = citationParser;
})(typeof window !== "undefined" ? window : globalThis);
