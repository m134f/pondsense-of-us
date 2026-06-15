/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pond: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e"
        }
      },
      boxShadow: {
        card: "0 12px 30px rgba(15, 118, 110, 0.08)"
      }
    }
  },
  plugins: []
};
