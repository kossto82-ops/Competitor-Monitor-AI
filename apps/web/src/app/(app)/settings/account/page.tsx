import { getOrganizationById, getUserForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

export default async function AccountSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  const [organization, user] = await Promise.all([
    getOrganizationById(session.organizationId),
    getUserForOrg(session.organizationId, session.userId),
  ]);

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Account</h1>
        <p className="text-sm text-slate-500">Your organization and account details.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-y-3 text-sm">
            <dt className="text-slate-400">Name</dt>
            <dd className="col-span-2 text-slate-900">{organization?.name}</dd>
            <dt className="text-slate-400">Plan</dt>
            <dd className="col-span-2 text-slate-900">{organization?.plan}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-y-3 text-sm">
            <dt className="text-slate-400">Email</dt>
            <dd className="col-span-2 text-slate-900">{user?.email}</dd>
            <dt className="text-slate-400">Role</dt>
            <dd className="col-span-2 text-slate-900">{user?.role}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
