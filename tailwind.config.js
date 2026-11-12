/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090d', 900: '#0d1117', 850: '#121821', 800: '#18202b',
          700: '#243042', 600: '#33435a', 400: '#8a9bb3', 200: '#c9d4e3', 50: '#f2f6fb',
        },
        synthetic: '#c084fc',
      },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
    },
  },
  plugins: [],
};
