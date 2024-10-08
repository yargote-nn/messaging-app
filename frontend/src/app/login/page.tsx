// src/app/login/page.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";

const loginDataSchema = z.object({
	user_id: z.number(),
	username: z.string(),
	token: z.string(),
	private_key: z.string(),
	public_key: z.string(),
});

interface LoginData {
	user_id: number;
	username: string;
	token: string;
	private_key: string;
	public_key: string;
}

export default function Login() {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const router = useRouter();
	const { toast } = useToast();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const response = await fetch("http://localhost:8080/api/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			const jsonData = await response.json();
			const { data, success } = loginDataSchema.safeParse(jsonData);
			if (success) {
				localStorage.setItem("token", data.token);
				localStorage.setItem("user_id", data.user_id.toString());
				localStorage.setItem("username", data.username);
				localStorage.setItem(`private_key_${data.user_id}`, data.private_key);
				localStorage.setItem(`public_key_${data.user_id}`, data.public_key);
				toast({
					title: "Login successful",
					description: "Welcome back!",
				});
				router.push("/chat");
				return;
			}
			toast({
				title: "Login failed",
				description: "Invalid credentials",
			});
		} catch (error) {
			console.error(error);
			toast({
				title: "Login failed",
				variant: "destructive",
			});
		}
	};

	return (
		<div className="flex min-h-screen flex-col items-center justify-center p-24">
			<h1 className="text-2xl font-bold mb-8">Login</h1>
			<form onSubmit={handleSubmit} className="space-y-4 w-full max-w-md">
				<Input
					type="text"
					placeholder="Username"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					required
				/>
				<Input
					type="password"
					placeholder="Password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
				<Button type="submit" className="w-full">
					Login
				</Button>
			</form>
		</div>
	);
}
