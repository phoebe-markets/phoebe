/**
 * The Phoebe wordmark: PHOEBE set in "Greek Freak" by PINISIART, converted to outlines (no font file shipped).
 * HACKATHON ONLY: Greek Freak is free for personal use only. Buy a commercial license or replace this mark
 * before the project goes beyond the hackathon. Regenerate by setting PHOEBE in the font and exporting the path.
 * `uid` keeps gradient ids unique when the mark appears more than once on a page.
 */
const D = "M9.50-68.90L10.40-68.40L50.40-40.80L18.50-26.40L18.50-23.90L18.50 0L8.40 0L8.40-56.30L0.90-61.50L7.80-70.10L9.50-69L9.50-68.90ZM30.10-42.70L18.50-50.60L18.50-37.30L30.10-42.70ZM98.10-42.20L98.10 0L88.10 0L88.10-42.20L67.30-42.20L67.30 0L57.30 0L57.30-42.20L52.20-42.20L52.20-52.30L57.30-52.30L57.30-70L67.30-70L67.30-52.30L88.10-52.30L88.10-70L98.10-70L98.10-52.30L102.70-52.30L102.70-42.20L98.10-42.20ZM121.10-15.40L105.20-35.60L133.50-69.70L161.80-35.60L145.90-15.40L133.50 0.30L121.10-15.40ZM147.70-36.80L143.70-41.60L136.40-50.40L133.50-54L118.10-35.60L119.70-33.60L132.20-17.50L133.40-16L148.80-35.50L147.70-36.80ZM161.60-49L198.90-70L204.70-62.10L177.80-45.70L186.40-34.90L177.00-23.20L204.70-8.20L198.90 0.10L161.60-20.90L163.60-23.30L173.40-35L169.10-40.20L169.00-40.20L161.60-49ZM206.40-61.20L213.80-69.70L254.30-43.50L235.90-35.20L254.60-23.10L213.80 0L213.80-56.60L206.40-61.20ZM233.10-44.90L223.80-50.90L223.80-40.90L233.10-44.90ZM223.80-30.20L223.80-17.40L234.40-23.40L223.80-30.20ZM256.20-49L293.50-70L299.30-62.10L272.40-45.70L281.00-34.90L271.60-23.20L299.30-8.20L293.50 0.10L256.20-20.90L258.20-23.30L268.00-35L263.70-40.20L263.60-40.20L256.20-49Z";
const VB = "-0.1 -71.1 300.4 72.4";

export function logoSvg(uid: string, title = "Phoebe"): string {
  const g = `phoebe-g-${uid}`;
  return `<svg class="logo" viewBox="${VB}" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
  <title>${title}</title>
  <defs>
    <linearGradient id="${g}" x1="-0.1" y1="-71.1" x2="300.30" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#d7dbe8"/>
      <stop offset=".8" stop-color="#c9c2ff"/><stop offset="1" stop-color="#9b8cff"/>
    </linearGradient>
  </defs>
  <path d="${D}" fill="url(#${g})"/>
</svg>`;
}
