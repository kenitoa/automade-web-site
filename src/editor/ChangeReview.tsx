function flatten(
  value: unknown,
  prefix = "",
  result: Record<string, string> = {},
): Record<string, string> {
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      if (!["data", "id", "updatedAt", "revision"].includes(key))
        flatten(item, prefix ? `${prefix}.${key}` : key, result);
  } else result[prefix] = value === undefined ? "(설정 없음)" : String(value);
  return result;
}
export default function ChangeReview({
  before,
  after,
}: {
  before: unknown;
  after: unknown;
}) {
  const old = flatten(before),
    next = flatten(after),
    keys = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
      (key) => old[key] !== next[key],
    );
  return (
    <div className="change-review">
      <table>
        <thead>
          <tr>
            <th>항목</th>
            <th>현재</th>
            <th>제안</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{old[key] || "(비어 있음)"}</td>
              <td>{next[key] || "(비어 있음)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!keys.length ? <p>변경된 항목이 없습니다.</p> : null}
    </div>
  );
}
