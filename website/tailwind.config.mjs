/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FAF6E8',
        parchment: '#F3EBD3',
        forest: '#2D5F3F',
        moss: '#4A7856',
        gold: '#C9A961',
        'gold-soft': '#E5D4A1',
        berry: '#8B3A4E',
        ink: '#1F2A24',
      },
      fontFamily: {
        display: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        prose: '68ch',
      },
      keyframes: {
        flutter: {
          '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
          '50%': { transform: 'translateY(-4px) rotate(-1deg)' },
        },
        drift: {
          '0%': { transform: 'translate(0, 0) rotate(0deg)', opacity: '0' },
          '20%': { opacity: '0.8' },
          '100%': { transform: 'translate(40px, -120px) rotate(180deg)', opacity: '0' },
        },
        glow: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        flutter: 'flutter 6s ease-in-out infinite',
        drift: 'drift 9s linear infinite',
        glow: 'glow 4s ease-in-out infinite',
      },
    },
  },
};
