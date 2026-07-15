// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Project page on GitHub Pages: https://colbymchenry.github.io/codegraph/
// `site` + `base` make every internal link resolve under the /codegraph/ prefix.
export default defineConfig({
	site: 'https://colbymchenry.github.io',
	base: '/codegraph',
	integrations: [
		starlight({
			title: 'codegraph',
			description:
				'A local-first code-intelligence tool that turns any codebase into a queryable knowledge graph for AI coding agents.',
			favicon: '/favicon.svg',
			head: [
				{
					// Default to the light / paper theme on first visit; the toggle still
					// lets a visitor switch to (and persist) the dark / ink theme.
					tag: 'script',
					content:
						"if(!localStorage.getItem('starlight-theme')){try{localStorage.setItem('starlight-theme','light')}catch(e){}document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light'}",
				},
			],
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/colbymchenry/codegraph',
				},
			],
			customCss: [
				'@fontsource-variable/archivo',
				'@fontsource/ibm-plex-mono/400.css',
				'@fontsource/ibm-plex-mono/500.css',
				'@fontsource/ibm-plex-mono/600.css',
				'./src/styles/theme.css',
			],
			components: {
				// Wordmark in the docs header.
				SiteTitle: './src/components/SiteTitle.astro',
				// Default GitHub icon + a live star-count pill (matches the landing nav).
				SocialIcons: './src/components/SocialIcons.astro',
			},
			expressiveCode: {
				themes: ['github-light', 'github-dark'],
				styleOverrides: {
					borderRadius: '0px',
					borderColor: '#cdcabf',
					codeFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
				},
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
						{ label: 'Your First Graph', slug: 'getting-started/your-first-graph' },
						{ label: 'Next Steps', slug: 'getting-started/next-steps' },
					],
				},
				{
					label: 'Core Concepts',
					items: [
						{ label: 'How It Works', slug: 'core-concepts/how-it-works' },
						{ label: 'The Knowledge Graph', slug: 'core-concepts/knowledge-graph' },
						{ label: 'Resolution & Frameworks', slug: 'core-concepts/resolution' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Indexing a Project', slug: 'guides/indexing' },
						{ label: 'Framework Routes', slug: 'guides/framework-routes' },
						{ label: 'Affected Tests in CI', slug: 'guides/affected-tests' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'MCP Server', slug: 'reference/mcp-server' },
						{ label: 'Integrations', slug: 'reference/integrations' },
						{ label: 'CLI', slug: 'reference/cli' },
						{ label: 'API', slug: 'reference/api' },
						{ label: 'Languages', slug: 'reference/languages' },
					],
				},
				{ label: 'Troubleshooting', slug: 'troubleshooting' },
			],
		}),
	],
});
