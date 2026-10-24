import { useTranslations } from "next-intl";
import { LEGAL_OPERATOR } from "../lib/legal-operator";

/** Operator, data controller and postal address from the single published record. */
export default function LegalOperator() {
  const t = useTranslations("static.common.legalOperator");
  const rows = [
    [t("operator"), LEGAL_OPERATOR.legalName],
    [t("controller"), LEGAL_OPERATOR.controller],
    [t("address"), `${LEGAL_OPERATOR.address}, ${LEGAL_OPERATOR.country}`],
  ] as const;
  return (
    <address
      data-legal-operator=""
      className="not-italic text-on-surface-variant"
      style={{ fontSize: 15.5, lineHeight: 1.8, margin: "0 0 18px 0" }}
    >
      {rows.map(([label, value]) => (
        <span key={label} style={{ display: "block" }}>
          <strong className="text-on-surface">{label}:</strong> <bdi>{value}</bdi>
        </span>
      ))}
    </address>
  );
}
