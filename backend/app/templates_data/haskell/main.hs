main :: IO ()
main = do
  putStrLn "Hello, Haskell!"
  print (take 10 fibs)
  where
    fibs = 0 : 1 : zipWith (+) fibs (tail fibs) :: [Integer]
