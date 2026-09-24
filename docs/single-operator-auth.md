# Single-operator authentication

Flip Manager permits one human operator. Create that account manually in Supabase Auth, then set its server-controlled app metadata to:

```json
{ "role": "operator" }
```

Do not put the role in `user_metadata`; users can change that field. Disable public email signups in the Supabase Auth provider settings before release. The application intentionally provides no signup, invitation, user-management, or role-management UI.

The login flow uses Supabase email and password authentication. The server stores the Supabase session in secure, HttpOnly, SameSite=Lax cookies and verifies every protected request with `auth.getUser()`. Create the operator and change its password only through the Supabase dashboard or another authorized administrative process. Never commit the operator e-mail, UUID, password, access token, refresh token, or service-role key.
