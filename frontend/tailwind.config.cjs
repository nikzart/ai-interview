/** @type {import('tailwindcss').Config} */
module.exports = { // Use module.exports
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'brand-bg': '#F8F9FC',
        'brand-surface': '#FFFFFF',
        'brand-primary': '#4A90E2',
        'brand-secondary': '#50E3C2',
        'brand-text-primary': '#333333',
        'brand-text-secondary': '#777777',
        'brand-border': '#EAEAEA',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
    // Remove nested plugins array from theme
  },
  plugins: [
    require('tailwind-scrollbar'), // Move plugin here
  ],
};
