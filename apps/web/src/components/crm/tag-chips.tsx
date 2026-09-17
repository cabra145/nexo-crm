import type { TagView } from '@nexo/contracts';

/** Etiquetas con su color, en pequeño. */
export function TagChips({ tags }: { tags: TagView[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
        >
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ backgroundColor: tag.color }}
          />
          {tag.name}
        </span>
      ))}
    </span>
  );
}
