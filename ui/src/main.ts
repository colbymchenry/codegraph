// Fonts are vendored, not fetched: a loopback reader for a local index must
// work with the network off, and must not announce the project to a CDN.
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './app.css';

import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('codegraph ui: #app host element is missing from index.html');

export default mount(App, { target });
