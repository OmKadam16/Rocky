// Page text extractor, injected with chrome.scripting.executeScript({ func }).
// Must stay self-contained: Chrome serializes the function, not its module.

/**
 * Runs inside the page (serialized by chrome.scripting): visible main text
 * only. Skips pages with password or payment fields, and never reads what's
 * typed into inputs, textareas or editable areas.
 */
export function extractPage() {
  const q = (s) => document.querySelector(s);
  if (q('input[type="password"]')) return { skip: "password" };
  if (
    q('input[autocomplete^="cc-"], input[name*="cardnumber" i], input[id*="cardnumber" i], input[name*="cvv" i], input[name*="cvc" i], iframe[src*="js.stripe.com/v3/elements-inner"], iframe[src*="hosted-fields"]')
  ) {
    return { skip: "payment" };
  }
  const root = q("article") || q("main") || q('[role="main"]') || document.body;
  if (!root) return { skip: "empty" };
  const SKIP = "script,style,noscript,template,svg,canvas,iframe,form,input,textarea,select,button,nav,header,footer,aside,[contenteditable],[contenteditable=''],[aria-hidden='true'],[hidden]";
  const BLOCK = /^(P|LI|H[1-6]|DIV|SECTION|ARTICLE|TR|BLOCKQUOTE|PRE|DD|DT|FIGCAPTION|BR)$/;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || el.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      if (el.checkVisibility && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let out = "";
  let last = null;
  for (let n = walker.nextNode(); n && out.length < 24000; n = walker.nextNode()) {
    const block = n.parentElement.closest("p,li,h1,h2,h3,h4,h5,h6,div,section,article,tr,blockquote,pre,dd,dt,figcaption");
    out += block !== last && last && BLOCK.test(block?.tagName || "") ? "\n" : " ";
    out += n.nodeValue;
    last = block;
  }
  const og = document.querySelector('meta[property="og:title"]');
  return { url: location.href, title: (og && og.content) || document.title || "", text: out };
}

