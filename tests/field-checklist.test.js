// Field-checklist guard (Week-3 of the productization plan).
//
// The plan requires a 25-item manual field checklist for real devices, with
// results reported in CHANGELOG.md only after actual execution. These tests
// fail if the checklist drifts: an item is added/removed silently, a result
// is checked off here before real execution, or the report section vanishes.
// The checklist is a reviewable artifact, not a static claim.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('field checklist (docs/FIELD_CHECKLIST.md)', () => {
  const path = join(ROOT, 'docs', 'FIELD_CHECKLIST.md');
  const checklist = existsSync(path) ? read('docs/FIELD_CHECKLIST.md') : '';

  it('exists', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('contains exactly 25 items', () => {
    expect(checklist).toBeTruthy();
    const items = checklist.match(/^- \[ \] \*\*بند /gm) ?? [];
    expect(items).toHaveLength(25);
  });

  it('has no pre-checked results (no fabricated field data)', () => {
    // Results are recorded in CHANGELOG after real execution, never here.
    const checked = checklist.match(/- \[x\]/g) ?? [];
    expect(checked).toHaveLength(0);
  });

  it('covers all 8 sections of the device matrix', () => {
    for (const section of [
      'A) التثبيت والأصول',
      'B) الهوية والجلسة',
      'C) الدردشة الثنائية والجماعية',
      'D) بنية MLS للمجموعات',
      'E) المكالمات',
      'F) الطوارئ والهلع',
      'G) الإشعارات والشبكات الخاصة',
      'H) التجربة العامة والحوكمة',
    ]) {
      expect(checklist).toContain(section);
    }
  });

  it('anchors every item to its automated test file', () => {
    // Each line must reference at least one repo test file (…test.js / .spec.js)
    const lines = checklist.match(/^- \[ \] \*\*بند .*$/gm) ?? [];
    expect(lines).toHaveLength(25);
    for (const line of lines) {
      expect(line).toMatch(/`[a-z0-9./-]+\.(test\.js|spec\.js|yml)`/);
    }
  });

  it('requires the report to land in CHANGELOG, not in this file', () => {
    expect(checklist).toContain('CHANGELOG.md');
    expect(checklist).toContain('تقرير النتائج');
  });
});
