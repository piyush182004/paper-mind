import { type ComponentType, StrictMode, lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { PaperDrawerProvider } from "./components/PaperDrawer";
import { Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import Welcome from "./pages/Welcome";
import "./index.css";

/** After a redeploy, old chunk names 404: reload once to pick up the new build instead of showing a blank page. */
function page(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    load()
      .then((m) => {
        sessionStorage.removeItem("pm-reloaded");
        return m;
      })
      .catch((e) => {
        if (!sessionStorage.getItem("pm-reloaded")) {
          sessionStorage.setItem("pm-reloaded", "1");
          window.location.reload();
        }
        throw e;
      }),
  );
}

const Dashboard = page(() => import("./pages/Dashboard"));
const Discover = page(() => import("./pages/Discover"));
const Library = page(() => import("./pages/Library"));
const SearchPage = page(() => import("./pages/Search"));
const Assistant = page(() => import("./pages/Assistant"));
const Clusters = page(() => import("./pages/Clusters"));
const GraphPage = page(() => import("./pages/Graph"));
const Analytics = page(() => import("./pages/Analytics"));
const Compare = page(() => import("./pages/Compare"));
const Insights = page(() => import("./pages/Insights"));
const About = page(() => import("./pages/About"));

/** Load every page in the background after sign-in so navigation is instant. */
const preload = () => [
  import("./pages/Dashboard"), import("./pages/Discover"), import("./pages/Library"), import("./pages/Search"), import("./pages/Assistant"),
  import("./pages/Clusters"), import("./pages/Graph"), import("./pages/Analytics"), import("./pages/Compare"), import("./pages/Insights"), import("./pages/About"),
];

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } } });

function App() {
  const { user, loading } = useAuth();
  useEffect(() => { if (user) { const t = setTimeout(() => void Promise.allSettled(preload()), 800); return () => clearTimeout(t); } }, [user]);
  if (loading) return <div className="p-8"><Spinner /></div>;
  if (!user) return <Welcome />;
  return (
    <PaperDrawerProvider>
      <Suspense fallback={<div className="p-8"><Spinner /></div>}>{/* pages suspend inside Layout; this only covers the shell */}
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="discover" element={<Discover />} />
            <Route path="library" element={<Library />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="assistant" element={<Assistant />} />
            <Route path="clusters" element={<Clusters />} />
            <Route path="graph" element={<GraphPage />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="compare" element={<Compare />} />
            <Route path="insights" element={<Insights />} />
            <Route path="how-it-works" element={<About />} />
            <Route path="*" element={<Dashboard />} />
          </Route>
        </Routes>
      </Suspense>
    </PaperDrawerProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
