/**
 * Build-time GitHub star count. Fetched once when the site is built (the GitHub
 * Actions runner has network); falls back to a constant locally / offline so a
 * build never hangs or fails on the network. The result is memoized for the
 * lifetime of the build process, so rendering it on every page is a single API
 * call, not one per page.
 */
function format(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
		return `${String(rounded).replace(/\.0$/, '')}k`;
	}
	return String(n);
}

async function fetchStars(fallback: string): Promise<string> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		const res = await fetch('https://api.github.com/repos/colbymchenry/codegraph', {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'codegraph-site',
			},
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) return fallback;
		const data = (await res.json()) as { stargazers_count?: number };
		return typeof data.stargazers_count === 'number' ? format(data.stargazers_count) : fallback;
	} catch {
		return fallback;
	}
}

let cached: Promise<string> | null = null;

export function getStarsLabel(fallback = '22k'): Promise<string> {
	cached ??= fetchStars(fallback);
	return cached;
}
