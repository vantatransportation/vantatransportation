import SetPassword from "@/components/driver/SetPassword";

export const metadata = { title: "Set your password" };
export default function Page() {
  return (
    <>
      <h1>Set your password</h1>
      <noscript><div className="notice notice--error">This page needs JavaScript to set your password. Please turn it on in your browser, or open the link in a different browser.</div></noscript>
      <SetPassword />
    </>
  );
}
