import { Navigate, useLocation } from "react-router-dom";

/**
 * Redirect an old route to its new path, keeping the query string and hash
 * (e.g. /devices?inspect=endpoint:5 -> /endpoints?inspect=endpoint:5).
 */
export default function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
