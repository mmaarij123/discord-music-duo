export const cooldownWarning = 'Please wait 3 seconds between commands.';

export function createCooldown({ now = () => performance.now(), max = 2000 } = {}) {
  const recent = new Map();
  return (guildId, userId) => {
    const time = now();
    for (const [key, entry] of recent) {
      if (entry.expiresAt > time) break;
      recent.delete(key);
    }

    const key = `${guildId}:${userId}`;
    const entry = recent.get(key);
    if (entry) {
      if (entry.warned) return 'silent';
      entry.warned = true;
      return 'warn';
    }
    if (recent.size >= max) return 'silent';
    recent.set(key, { expiresAt: time + 3000, warned: false });
    return 'allow';
  };
}
