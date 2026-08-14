// sample.ts - synthetic TypeScript file for Explorer preview testing

interface Item {
  id: number;
  label: string;
}

const items: Item[] = [
  { id: 1, label: "Apple" },
  { id: 2, label: "Banana" },
  { id: 3, label: "Grape" },
];

function describe(item: Item): string {
  return `#${item.id}: ${item.label}`;
}

items.forEach((item) => console.log(describe(item)));
