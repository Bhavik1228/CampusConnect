grant execute on function public.return_library_book(text) to anon, authenticated;

notify pgrst, 'reload schema';
