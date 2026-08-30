export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>RecoLoop</h1>
      <p>
        Data foundation only. Generate a dataset with{" "}
        <code>npx tsx scripts/generate.ts --seed 42 --orders 500 --defects 40</code>.
      </p>
    </main>
  );
}
