import { useEffect, useState } from "react";
import { StoreProvider } from "./state";
import { Landing } from "./views/Landing";
import { Dashboard } from "./views/Dashboard";

function useHashRoute(): string {
  const [route, setRoute] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const isApp = route.startsWith("#/app");

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [isApp]);

  return <StoreProvider>{isApp ? <Dashboard /> : <Landing />}</StoreProvider>;
}
