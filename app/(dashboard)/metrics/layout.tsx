import type { ReactNode } from "react";
import styles from "./metrics-layout.module.css";

export default function MetricsLayout({ children }: { children: ReactNode }) {
  return <div className={styles.metricsRoute}>{children}</div>;
}
