import test from 'node:test';
import assert from 'node:assert/strict';
import { versionManager } from '../public/ui/VersionManager.js';

test('release note fallback renders common Markdown without exposing HTML', () => {
  const html = versionManager.formatReleaseNotes([
    '# Gharmonize v1.3.9',
    '',
    '**Bold** and *italic* with `inline code`.',
    '',
    '* first item',
    '* second item',
    '',
    '```bash',
    'docker pull ghcr.io/g-grbz/gharmonize:latest',
    '```',
    '',
    '[Release page](https://github.com/G-grbz/Gharmonize/releases)',
    '<script>alert(1)</script>'
  ].join('\n'));

  assert.match(html, /<h2>Gharmonize v1\.3\.9<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<ul><li>first item<\/li><li>second item<\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-bash">docker pull ghcr\.io&#47;g-grbz&#47;gharmonize:latest<\/code><\/pre>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;&#47;script&gt;/);
});
