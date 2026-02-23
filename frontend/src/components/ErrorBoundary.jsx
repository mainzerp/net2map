import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", color: "#e74c3c",
          fontFamily: "Inter, sans-serif", gap: 12
        }}>
          <h2 style={{ margin: 0 }}>Something went wrong</h2>
          <p style={{ color: "#aaa", margin: 0 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 8, padding: "8px 20px", background: "#e74c3c",
              color: "#fff", border: "none", borderRadius: 6, cursor: "pointer"
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
