export interface TextDiffPart {
  kind: 'equal' | 'added' | 'removed';
  text: string;
}

/** Complete inputs are retained even when a detailed diff exceeds the work budget. */
export function textDiff(before: string, after: string): {parts: TextDiffPart[]; simplified: boolean} {
  if (before === after) return {parts: [{kind: 'equal', text: before}], simplified: false};
  const segmenter = new Intl.Segmenter('en', {granularity: 'word'});
  const left = Array.from(segmenter.segment(before), part => part.segment);
  const right = Array.from(segmenter.segment(after), part => part.segment);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const a = left.slice(start, left.length - end), b = right.slice(start, right.length - end);
  const parts: TextDiffPart[] = [];
  const append = (kind: TextDiffPart['kind'], text: string) => {
    if (!text) return;
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else parts.push({kind, text});
  };
  append('equal', left.slice(0, start).join(''));
  const simplified = (a.length + 1) * (b.length + 1) > 250_000;
  if (simplified) {
    append('removed', a.join(''));
    append('added', b.join(''));
  } else {
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] = a[i] === b[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        append('equal', a[i++]); j++;
      } else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        append('removed', a[i++]);
      } else append('added', b[j++]);
    }
  }
  append('equal', end ? left.slice(left.length - end).join('') : '');
  return {parts, simplified};
}
