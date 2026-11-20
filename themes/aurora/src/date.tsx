/** A publication date as a machine-readable, language-neutral `<time>` element (UTC date). */
export function PostDate(props: { date: Date | null | undefined }) {
  if (!props.date) return null;
  const iso = props.date.toISOString().slice(0, 10);
  return (
    <time class="np-aurora-date" datetime={iso}>
      {iso}
    </time>
  );
}
