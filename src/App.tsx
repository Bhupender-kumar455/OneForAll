import { type ReactNode } from "react";
import { Route, Switch, useLocation, Router as WouterRouter } from "wouter";

import { ErrorBoundary } from "@/components/error-boundary";
import FormatterPage from "@/pages/formatter";
import NotFound from "@/pages/not-found";
import TextExtractor from "@/pages/text-extractor";

/** The whole app shares one error boundary that resets when the route changes. */
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={FormatterPage} />
        <Route path="/extract" component={TextExtractor} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

export default function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}
