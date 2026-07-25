import { getGuide } from '../src/data/wikivoyage.ts';
import { CATEGORY_MAP } from '../src/data/categories.ts';

const query = process.argv[2] ?? 'Kyoto';

const guide = await getGuide(query);
console.log('='.repeat(60));
console.log(`GUIDE: ${guide.title}`);
console.log(`center: ${guide.center}  bbox: ${guide.bbox}`);
console.log(`intro: ${guide.intro.slice(0, 160)}...`);
console.log(`advice sections: ${guide.advice.map((a) => a.title).join(', ')}`);
console.log(`related: ${guide.related.slice(0, 6).join(', ')}`);
console.log(`total destinations: ${guide.destinations.length}`);
console.log('-'.repeat(60));

const byCat: Record<string, typeof guide.destinations> = {};
for (const d of guide.destinations) (byCat[d.category] ??= []).push(d);

for (const [cat, items] of Object.entries(byCat)) {
  console.log(`\n### ${CATEGORY_MAP[cat as keyof typeof CATEGORY_MAP].label} (${items.length})`);
  items
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5)
    .forEach((d) => {
      console.log(
        `  #${d.rank} [${d.score}] ${d.name}` +
          (d.lat != null ? ` @(${d.lat.toFixed(3)},${d.lon!.toFixed(3)})` : ' (no coords)'),
      );
    });
}
