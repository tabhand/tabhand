// Cursor looks per agent harness. The MCP server works out which harness is driving it and sends
// the key; anything unknown falls back to `agent`. Arrows are always colored so they can't be
// mistaken for the user's own (black and white) pointer.

export const THEMES = {
  claude: {
    arrow: ['#F0A07F', '#C4603E'],
    pill: 'linear-gradient(135deg, #E48A66 0%, #C15F3C 100%)',
    text: '#FFFFFF',
    glyph: 'spark',
    glyphColor: '#FFFFFF',
    glow: 'rgba(214, 112, 76, 0.45)',
    group: 'orange',
  },
  codex: {
    arrow: ['#8FB2FF', '#3D67DE'],
    pill: 'linear-gradient(135deg, #353A44 0%, #101216 100%)',
    text: '#FFFFFF',
    glyph: 'prompt',
    glyphColor: '#9DBBFF',
    glow: 'rgba(61, 103, 222, 0.42)',
    group: 'blue',
  },
  opencode: {
    arrow: ['#FDD2AE', '#F29A5A'],
    pill: 'linear-gradient(135deg, #222222 0%, #0A0A0A 100%)',
    text: '#EEEEEE',
    glyph: 'pixel',
    glyphColor: '#FAB283',
    glow: 'rgba(242, 154, 90, 0.40)',
    group: 'yellow',
  },
  cursor: {
    arrow: ['#C3CDDB', '#5D6B82'],
    pill: 'linear-gradient(135deg, #26272B 0%, #050505 100%)',
    text: '#F4F4F5',
    glyph: 'cube',
    glyphColor: '#E4E4E7',
    glow: 'rgba(93, 107, 130, 0.42)',
    group: 'grey',
  },
  gemini: {
    arrow: ['#79AEFF', '#8E6CEF'],
    pill: 'linear-gradient(120deg, #4796E3 0%, #9177C7 55%, #CA6673 100%)',
    text: '#FFFFFF',
    glyph: 'sparkle',
    glyphColor: '#FFFFFF',
    glow: 'rgba(145, 119, 199, 0.45)',
    group: 'pink',
  },
  copilot: {
    arrow: ['#7CC0FF', '#1F7FE0'],
    pill: 'linear-gradient(135deg, #1A7FD6 0%, #0A4F8C 100%)',
    text: '#FFFFFF',
    glyph: 'orbit',
    glyphColor: '#FFFFFF',
    glow: 'rgba(31, 127, 224, 0.42)',
    group: 'cyan',
  },
  agent: {
    arrow: ['#B9A2FF', '#7C3AED'],
    pill: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
    text: '#FFFFFF',
    glyph: 'orbit',
    glyphColor: '#FFFFFF',
    glow: 'rgba(124, 58, 237, 0.42)',
    group: 'purple',
  },
};

export const themeFor = (key) => ({ key: THEMES[key] ? key : 'agent', ...(THEMES[key] ?? THEMES.agent) });
