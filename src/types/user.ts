export enum UserRole {
  Owner = "owner",
  Editor = "editor",
  Viewer = "viewer",
  None = "none",
}

export type UserRoleResponse = {
  role: UserRole
}
