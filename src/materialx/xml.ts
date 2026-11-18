export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  parent: XmlElement | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return ENTITIES[entity] ?? match;
});

/** Parses the element structure of an XML document; text content is ignored. */
export function parseXml(text: string): XmlElement {
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attribute = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const document: XmlElement = { tag: '#document', attrs: {}, children: [], parent: null };
  let current = document;
  for (const match of text.matchAll(token)) {
    const [, closing, tag, attrs, selfClosing] = match;
    if (!tag) continue;
    if (closing) {
      if (current.tag !== tag) throw new Error(`Malformed XML: unexpected </${tag}>`);
      current = current.parent!;
      continue;
    }
    const element: XmlElement = { tag, attrs: {}, children: [], parent: current };
    for (const [, name, double, single] of attrs.matchAll(attribute)) element.attrs[name] = decode(double ?? single ?? '');
    current.children.push(element);
    if (!selfClosing) current = element;
  }
  if (current !== document) throw new Error(`Malformed XML: <${current.tag}> is not closed`);
  const root = document.children[0];
  if (!root) throw new Error('The file is empty');
  return root;
}
